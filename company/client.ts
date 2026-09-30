import { serviceDefaults } from '../cordis/config.js';
import type { CompanyClientOptions } from '../cordis/config.js';
export type { CompanyClientOptions } from '../cordis/config.js';
/** 浏览器入口只依赖 Cordis core；不导入 Node.js 或 CLI。 */
import { Service, type Context } from '@cordisjs/core';
import '../cordis/dag.js';
import '../pixel-studio/service.js';
import type { CompanyClientState, CompanySnapshot } from './types.js';
declare module '@cordisjs/core' { interface Context { companyClient: CompanyClientService } }

export class CompanyClientService extends Service {
  private state: CompanyClientState = Object.freeze({ connected: false, tasks: [], selectedRunId: null, current: null, error: '' });
  private readonly listeners = new Set<() => void>();
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly baseURL: string;
  private readonly pollMs: number;
  private generation = 0;
  constructor(ctx: Context, options: CompanyClientOptions = {}) {
    super(ctx, 'companyClient');
    this.baseURL = options.baseURL ?? serviceDefaults.companyClient.baseURL;
    this.pollMs = options.pollMs ?? serviceDefaults.companyClient.pollMs;
    ctx.on('ready', () => { void this.poll(); });
    ctx.on('dispose', () => { this.controller.abort(); clearTimeout(this.timer); this.ctx.pixelStudio.setConnected(false); this.listeners.clear(); });
  }
  readonly getSnapshot = (): CompanyClientState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<CompanyClientState>): void {
    if (this.controller.signal.aborted) return;
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }
  private async request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const response = await fetch(this.baseURL + path, { method, signal: this.controller.signal, headers: data === undefined ? {} : { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error ?? `公司服务连接失败 (${response.status})`);
    }
    return response.json() as Promise<T>;
  }
  private project(current: CompanySnapshot | null, connected = true): void {
    if (!current) { this.ctx.dagGraph.setGraph({ nodes: [], edges: [] }); this.ctx.pixelStudio.publish({ version: 1, runId: 'company-idle', title: '等待委派', revision: 1, actors: [], tasks: [], handoffs: [] }, { reconnect: connected }); this.ctx.pixelStudio.setConnected(connected); return; }
    this.ctx.dagGraph.setGraph({
      nodes: current.run?.graph.nodes.map(node => ({ ...node, data: { ...node.data, label: node.data.instruction, status: current.run!.states[node.id].status } })) ?? [],
      edges: current.run?.graph.edges.map(edge => ({ ...edge, data: { ...edge.data } })) ?? [],
    });
    this.ctx.pixelStudio.publish(current.studio, { reconnect: connected && !this.state.connected });
    this.ctx.pixelStudio.setConnected(connected);
  }
  select(runId: string): void {
    const current = this.state.tasks.find(task => task.runId === runId);
    if (!current) return;
    this.project(current, this.state.connected);
    this.update({ selectedRunId: runId, current });
  }
  async submit(objective: string): Promise<void> {
    const task = await this.request<CompanySnapshot>('/tasks', 'POST', { objective });
    // 忽略已经发出但尚未返回的旧轮询，防止覆盖刚提交的任务。
    this.generation++;
    this.project(task);
    this.update({ connected: true, tasks: [task, ...this.state.tasks.filter(item => item.runId !== task.runId)], selectedRunId: task.runId, current: task, error: '' });
  }
  async cancel(): Promise<void> {
    if (!this.state.current) return;
    const task = await this.request<CompanySnapshot>(`/tasks/${this.state.current.runId}/cancel`, 'POST', {});
    this.generation++;
    const tasks = this.state.tasks.map(item => item.runId === task.runId ? task : item);
    const current = this.state.selectedRunId === task.runId ? task : this.state.current;
    this.project(current);
    this.update({ tasks, current, error: '' });
  }
  private async poll(): Promise<void> {
    const generation = this.generation;
    try {
      const tasks = await this.request<CompanySnapshot[]>('/tasks');
      if (generation !== this.generation) return;
      const selectedRunId = tasks.some(task => task.runId === this.state.selectedRunId) ? this.state.selectedRunId : tasks[0]?.runId ?? null;
      const current = tasks.find(task => task.runId === selectedRunId) ?? null;
      if (current?.runId !== this.state.current?.runId || current?.revision !== this.state.current?.revision || !this.state.connected) this.project(current);
      this.update({ tasks, selectedRunId, current, connected: true, error: '' });
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.ctx.pixelStudio.setConnected(false);
        this.update({ connected: false, error: `无法连接公司服务。请运行 npm run company 或 npm run company:demo。${error instanceof Error ? error.message : ''}` });
      }
    } finally { if (!this.controller.signal.aborted) this.timer = setTimeout(() => { void this.poll(); }, this.pollMs); }
  }
}
export const companyClientPlugin = {
  name: 'company-client', inject: ['dagGraph', 'pixelStudio'], provide: 'companyClient',
  apply(ctx: Context, options: CompanyClientOptions = {}) { return new CompanyClientService(ctx, options); },
};
