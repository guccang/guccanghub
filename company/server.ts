import { serviceDefaults } from '../cordis/config.js';
import type { CompanyServerOptions } from '../cordis/config.js';
export type { CompanyServerOptions } from '../cordis/config.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Service, type Context } from 'cordis';
import './service.js';

declare module 'cordis' { interface Context { companyServer: CompanyServerService } }
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请发送 application/json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > serviceDefaults.companyServer.maxBodyBytes) throw new HttpError(413, '请求体超过 256 KiB');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, '请求不是有效 JSON'); }
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}
/** 本机 HTTP 桥；仅监听回环地址，供浏览器读取任务快照与提交/停止任务。 */
export class CompanyServerService extends Service {
  private readonly server: Server;
  private origin = '';
  readonly ready: Promise<void>;
  constructor(ctx: Context, options: CompanyServerOptions = {}) {
    const port = options.port ?? serviceDefaults.companyServer.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port 无效');
    super(ctx, 'companyServer');
    this.server = createServer((request, response) => { void this.handle(request, response, options.staticDir).catch(error => {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      json(response, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : '服务处理失败，请检查服务端日志' });
    }); });
    this.server.requestTimeout = serviceDefaults.companyServer.requestTimeoutMs;
    this.server.headersTimeout = serviceDefaults.companyServer.headersTimeoutMs;
    this.ready = new Promise((resolveReady, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, serviceDefaults.companyServer.host, () => {
        this.origin = `http://${serviceDefaults.companyServer.host}:${(this.server.address() as AddressInfo).port}`;
        resolveReady();
      });
    });
    ctx.on('dispose', async () => {
      await this.ready.catch(() => {});
      if (!this.server.listening) return;
      await new Promise<void>((resolveClose, reject) => { this.server.close(error => error ? reject(error) : resolveClose()); this.server.closeAllConnections(); });
    });
  }
  get url(): string { return this.origin; }
  private async handle(request: IncomingMessage, response: ServerResponse, staticDir?: string): Promise<void> {
    // 防止恶意站点通过本机浏览器发起 CLI 任务；Vite 开发代理去除 Origin。
    const host = request.headers.host;
    if (!this.origin || host !== new URL(this.origin).host) throw new HttpError(403, 'Host 不被允许');
    if (request.headers.origin && request.headers.origin !== this.origin) throw new HttpError(403, 'Origin 不被允许');
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '跨站请求不被允许');
    const url = new URL(request.url ?? '/', this.origin);
    const tasksPath = `${serviceDefaults.companyClient.baseURL}/tasks`;
    if (url.pathname === tasksPath) {
      if (request.method === 'GET') { json(response, 200, this.ctx.company.list()); return; }
      if (request.method === 'POST') {
        const value = await body(request);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '任务必须是 JSON 对象');
        try { json(response, 202, this.ctx.company.submit(value as Parameters<typeof this.ctx.company.submit>[0])); }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : '任务无效'); }
        return;
      }
      throw new HttpError(405, '方法不被允许');
    }
    const match = url.pathname.startsWith(tasksPath + '/') ? /^([a-f0-9-]+)(\/cancel)?$/.exec(url.pathname.slice(tasksPath.length + 1)) : null;
    if (match) {
      try { this.ctx.company.getSnapshot(match[1]); } catch { throw new HttpError(404, '任务不存在'); }
      if (!match[2] && request.method === 'GET') { json(response, 200, this.ctx.company.getSnapshot(match[1])); return; }
      if (match[2] && request.method === 'POST') { await body(request); json(response, 200, this.ctx.company.cancel(match[1])); return; }
      throw new HttpError(405, '方法不被允许');
    }
    if (url.pathname.startsWith('/api/') || !staticDir || request.method !== 'GET') throw new HttpError(404, '接口不存在');
    const root = await realpath(resolve(staticDir));
    let file: string;
    try { file = await realpath(resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))); }
    catch { throw new HttpError(404, '文件不存在'); }
    if (!file.startsWith(root + sep)) throw new HttpError(403, '文件路径不被允许');
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
    const data = await readFile(file);
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    response.end(data);
  }
}
export const companyServerPlugin = {
  name: 'company-server', inject: ['company'], provide: 'companyServer',
  apply(ctx: Context, options: CompanyServerOptions = {}) { return new CompanyServerService(ctx, options); },
};
