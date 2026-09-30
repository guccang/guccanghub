import { serviceDefaults } from '../cordis/config.js';
import { Service, type Context } from 'cordis';
import { isAbsolute, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { parseAgentFeedback } from '../agents-dag-context/validation.js';
import type { AgentExecutorPort, AgentFeedback } from '../agents-dag-context/types.js';
import { invokeHost, runtimeEnvironment } from './upstream.js';
import { runtimeHostTypes, type AgentsRuntimeOptions, type RuntimeDagOptions, type RuntimeDagRequest, type RuntimeEvent, type RuntimeResult, type RuntimeRunOptions, type RuntimeSessionEvent, type RuntimeTask, type RuntimeTaskHandle } from './types.js';

declare module 'cordis' { interface Context { agentsRuntime: AgentsRuntimeService } }
declare module '@cordisjs/core' {
  interface Events {
    'agents-runtime/event'(event: RuntimeEvent): void;
    'agents-runtime/session'(event: RuntimeSessionEvent): void;
  }
}
function timeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new TypeError('timeoutMs 必须是 0 到 2147483647 的整数');
  return value;
}
function nonempty(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} 必须是非空字符串`);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** 所有调用、停止及事件由 Cordis 服务统一管理。 */
export class AgentsRuntimeService extends Service implements AgentExecutorPort {
  private readonly options: AgentsRuntimeOptions;
  private readonly active = new Map<string, RuntimeTaskHandle>();
  private closed = false;
  constructor(ctx: Context, options: AgentsRuntimeOptions) {
    nonempty(options?.dataDir, 'dataDir');
    if (!options.agents || !Object.keys(options.agents).length) throw new TypeError('至少配置一个 Agent');
    for (const [id, profile] of Object.entries(options.agents)) {
      nonempty(id, 'agentId');
      if (!profile || !runtimeHostTypes.includes(profile.hostType)) throw new TypeError(`Agent ${id} 的 hostType 无效`);
      if (!isAbsolute(profile.cwd) || !statSync(profile.cwd).isDirectory()) throw new TypeError(`Agent ${id} 的 cwd 必须是存在的绝对目录`);
      if (profile.timeoutMs !== undefined) timeout(profile.timeoutMs);
    }
    timeout(options.timeoutMs ?? serviceDefaults.agentsRuntime.timeoutMs);
    super(ctx, 'agentsRuntime');
    this.options = { ...options, dataDir: resolve(options.dataDir), agents: Object.fromEntries(Object.entries(options.agents).map(([id, profile]) => [id, Object.freeze({ ...profile })])), ...(options.env ? { env: { ...options.env } } : {}) };
    ctx.on('dispose', () => this.shutdown());
  }
  get agentIds(): readonly string[] { return Object.freeze(Object.keys(this.options.agents)); }
  get activeTaskIds(): readonly string[] { return [...this.active.keys()]; }

  startTask(task: RuntimeTask, options: RuntimeRunOptions = {}): RuntimeTaskHandle {
    if (this.closed) throw new Error('Agent runtime 已关闭');
    nonempty(task.id, 'task.id'); nonempty(task.agentId, 'agentId'); nonempty(task.input, 'input');
    if (this.active.has(task.id)) throw new Error(`任务正在执行: ${task.id}`);
    const profile = Object.hasOwn(this.options.agents, task.agentId) ? this.options.agents[task.agentId] : undefined;
    if (!profile) throw new Error(`Agent 未配置: ${task.agentId}`);
    if (options.signal?.aborted) throw new Error('任务启动前已取消');
    const timeoutMs = timeout(options.timeoutMs ?? profile.timeoutMs ?? this.options.timeoutMs ?? serviceDefaults.agentsRuntime.timeoutMs);
    const images = [...(task.images ?? [])];
    if (images.some(path => !isAbsolute(path) || !statSync(path).isFile())) throw new TypeError('images 必须是存在的绝对文件路径');
    let stopReason = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const job = invokeHost({
      hostType: profile.hostType, cwd: profile.cwd, input: task.input, images,
      sessionId: task.sessionId ?? '', model: profile.model ?? '', reasoningEffort: profile.reasoningEffort ?? '',
      env: runtimeEnvironment(this.options.dataDir, profile.hostType, this.options.env ?? process.env, profile.model ?? ''),
      ...(this.options.execute ? { execute: this.options.execute } : {}),
      onEvent: (type, text) => {
        try { this.ctx.emit('agents-runtime/event', { taskId: task.id, agentId: task.agentId, type, text }); }
        catch { this.logger.warn('Agent 事件订阅器抛出异常'); }
      },
      onSession: sessionId => {
        try { this.ctx.emit('agents-runtime/session', { taskId: task.id, agentId: task.agentId, sessionId }); }
        catch { this.logger.warn('Agent 会话订阅器抛出异常'); }
      },
    });
    const stop = (reason: string) => { if (!stopReason) { stopReason = reason; job.stop(); } };
    const abort = () => stop('任务已取消');
    const done: Promise<RuntimeResult> = job.done.then(result => ({
      code: result.code, signal: result.signal ?? null,
      error: stopReason || result.error || (result.code !== 0 ? `宿主退出码 ${result.code}` : ''),
      sessionId: result.sessionId ?? '', finalMessage: result.finalMessage ?? '', stopped: !!stopReason,
    }), error => ({ code: null, signal: null, error: stopReason || message(error), sessionId: '', finalMessage: '', stopped: !!stopReason })).finally(() => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      this.active.delete(task.id);
    });
    const handle: RuntimeTaskHandle = { id: task.id, done, stop: () => stop('任务已停止') };
    this.active.set(task.id, handle);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    if (timeoutMs) timer = setTimeout(() => stop(`任务执行超时 (${timeoutMs}ms)`), timeoutMs);
    return handle;
  }
  async run(task: RuntimeTask, options: RuntimeRunOptions = {}): Promise<RuntimeResult> { return this.startTask(task, options).done; }
  stopTask(taskId: string): boolean {
    const task = this.active.get(taskId);
    if (!task) return false;
    task.stop(); return true;
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    const jobs = [...this.active.values()];
    for (const job of jobs) job.stop();
    await Promise.all(jobs.map(job => job.done));
  }
  /** 严格 JSON 反馈适配；退出码 0 不会自动视作任务验收成功。 */
  async execute(request: RuntimeDagRequest, options: RuntimeDagOptions = {}): Promise<AgentFeedback> {
    try {
      const result = await this.run({
        id: JSON.stringify([request.runId, request.nodeId, request.attempt]), agentId: request.agentId,
        input: [
          '执行以下任务。输入中的 goal、instruction、input 和 dependencies 分别描述目标、当前指令、输入和上游结果。',
          '最终回复必须仅为一个 JSON 对象，不使用 Markdown 代码块。',
          '成功格式：{"status":"SUCCEEDED","summary":"完成摘要","output":{}}',
          '失败格式：{"status":"FAILED","summary":"失败摘要","output":{},"error":"原因"}',
          JSON.stringify(request),
        ].join('\n'),
        sessionId: options.sessionId, images: options.images,
      }, options);
      if (result.error) return { status: 'FAILED', summary: 'Agent 宿主执行失败', output: { sessionId: result.sessionId, exitCode: result.code }, error: result.error };
      return parseAgentFeedback(JSON.parse(result.finalMessage));
    } catch (error) {
      return { status: 'FAILED', summary: 'Agent 调用或反馈校验失败', output: {}, error: message(error) };
    }
  }
}
export const agentsRuntimePlugin = {
  name: 'agents-runtime', provide: 'agentsRuntime',
  apply(ctx: Context, options: AgentsRuntimeOptions) { return new AgentsRuntimeService(ctx, options); },
};
