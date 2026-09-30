import { copyJson as clone, freeze } from '../cordis/utils.js';
import { serviceDefaults } from '../cordis/config.js';
import { randomUUID } from 'node:crypto';
import { Service, type Context } from 'cordis';
import { AgentsDagService } from '../cordis/index.js';
import '../agents-runtime/service.js';
import { validateGoal, validatePlannedDag } from '../agents-dag-context/validation.js';
import type { AgentExecutionInput, AgentGoal, AgentRunSnapshot, PlannedAgentNode, JsonObject } from '../agents-dag-context/types.js';
import type { Dag } from '../dag/types.js';
import { topologicalOrder } from '../dag/index.js';
import { agentRunToStudio } from '../pixel-studio/adapter.js';
import type { CompanyOptions, CompanySnapshot, CompanyTaskInput } from './types.js';

declare module 'cordis' { interface Context { company: CompanyService } }
interface Job { snapshot: CompanySnapshot; controller: AbortController; done: Promise<void>; settled: boolean }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} 必须是正整数`);
  return value;
}
/** 一次提交负责规划、文件式 context、节点调度及显示快照。 */
export class CompanyService extends Service {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<() => void>();
  private readonly runtime: AgentsDagService['runtime'];
  private readonly settings: Required<CompanyOptions>;
  private closed = false;
  constructor(ctx: Context, options: CompanyOptions) {
    if (!options?.rootDir?.trim() || !options.plannerAgentId?.trim() || !options.workerAgentIds?.length || options.workerAgentIds.some(id => typeof id !== 'string' || !id.trim())) throw new TypeError('需要 rootDir、规划 Agent 和执行 Agent 列表');
    const config = { ...options, workerAgentIds: [...new Set(options.workerAgentIds)], maxNodes: positive(options.maxNodes ?? serviceDefaults.company.maxNodes, 'maxNodes'), maxConcurrentTasks: positive(options.maxConcurrentTasks ?? serviceDefaults.company.maxConcurrentTasks, 'maxConcurrentTasks'), maxTasks: positive(options.maxTasks ?? serviceDefaults.company.maxTasks, 'maxTasks') };
    const available = ctx.agentsRuntime.agentIds;
    if ([config.plannerAgentId, ...config.workerAgentIds].some(id => !available.includes(id))) throw new TypeError('公司配置引用了未注册的 Agent');
    super(ctx, 'company');
    this.settings = config;
    // 同一 Cordis 插件作用域注册 context；调用链仍通过 ctx.agentsRuntime 执行。
    this.runtime = new AgentsDagService(ctx, {
      rootDir: config.rootDir,
      planner: { decompose: request => this.plan(request.runId, request.goal) },
      executor: { execute: request => this.execute(request) },
    }).runtime;
    ctx.on('dispose', () => this.shutdown());
  }
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  list(): readonly CompanySnapshot[] { return [...this.jobs.values()].map(job => job.snapshot).reverse(); }
  getSnapshot(runId: string): CompanySnapshot { return this.job(runId).snapshot; }
  /** 返回规划中的快照，后台继续执行；不会阻塞 HTTP 请求。 */
  submit(input: CompanyTaskInput): CompanySnapshot {
    if (this.closed) throw new Error('公司服务已关闭');
    if (!input || typeof input.objective !== 'string') throw new TypeError('任务 objective 必须是字符串');
    const goal = { objective: input.objective.trim(), context: input.context === undefined ? {} : input.context };
    validateGoal(goal);
    if (goal.objective.length > 16000) throw new Error('任务文本最多 16000 字符');
    if ([...this.jobs.values()].filter(job => !job.settled).length >= this.settings.maxConcurrentTasks) throw new Error('已有任务正在执行，请等待完成或停止任务');
    if (this.jobs.size >= this.settings.maxTasks) throw new Error('本次服务已达到任务数量上限，请重启服务；context 文件仍保留');
    const runId = randomUUID();
    const at = new Date().toISOString();
    const snapshot: CompanySnapshot = freeze({ runId, objective: goal.objective, status: 'PLANNING', revision: 1, createdAt: at, updatedAt: at, feedback: {}, studio: { version: 1, runId, title: goal.objective, revision: 1, actors: [{ id: this.settings.plannerAgentId, name: this.settings.plannerAgentId, character: 'michael', status: 'working', activity: '拆解任务与安排依赖', isLead: true }], tasks: [], handoffs: [] } });
    const job: Job = { snapshot, controller: new AbortController(), done: Promise.resolve(), settled: false };
    this.jobs.set(runId, job);
    const frozenGoal = freeze(clone(goal));
    job.done = Promise.resolve().then(() => this.process(runId, frozenGoal)).finally(() => { job.settled = true; });
    this.notify();
    return snapshot;
  }
  cancel(runId: string): CompanySnapshot {
    const job = this.job(runId);
    if (!['PLANNING', 'RUNNING'].includes(job.snapshot.status)) return job.snapshot;
    job.controller.abort();
    this.change(runId, { status: 'CANCELLED', error: '用户停止了任务' });
    return job.snapshot;
  }
  async wait(runId: string): Promise<CompanySnapshot> { const job = this.job(runId); await job.done; return job.snapshot; }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const [id, job] of this.jobs) if (['PLANNING', 'RUNNING'].includes(job.snapshot.status)) this.cancel(id);
    await Promise.all([...this.jobs.values()].map(job => job.done));
    this.listeners.clear();
  }
  private job(runId: string): Job { const job = this.jobs.get(runId); if (!job) throw new Error('任务不存在'); return job; }
  private notify(): void { for (const listener of this.listeners) { try { listener(); } catch { this.logger.warn('公司服务订阅器异常'); } } }
  private change(runId: string, patch: Partial<CompanySnapshot>): void {
    const job = this.job(runId);
    const revision = job.snapshot.revision + 1;
    const next = { ...job.snapshot, ...patch, revision, updatedAt: new Date().toISOString() };
    const studio = next.run ? agentRunToStudio(next.run, { revision }) : { ...next.studio, revision };
    if (next.status === 'CANCELLED' || next.status === 'FAILED') {
      const status = next.status === 'CANCELLED' ? 'paused' as const : 'error' as const;
      next.studio = { ...studio, actors: studio.actors.map(actor => ['working', 'idle', 'blocked'].includes(actor.status) ? { ...actor, status, activity: next.error ?? '' } : actor), tasks: studio.tasks.map(task => ['working', 'idle', 'blocked'].includes(task.status) ? { ...task, status } : task) };
    } else next.studio = studio;
    job.snapshot = freeze(clone(next));
    this.notify();
  }
  private async refresh(runId: string): Promise<AgentRunSnapshot> {
    const run = await this.runtime.getSnapshot(runId);
    const contexts = await Promise.all(run.graph.nodes.map(node => this.runtime.getNodeContext(runId, node.id)));
    const feedback = Object.fromEntries(contexts.filter(node => node.feedback).map(node => [node.node.id, node.feedback!]));
    this.change(runId, { run, feedback });
    return run;
  }
  private async plan(runId: string, goal: AgentGoal): Promise<Dag<PlannedAgentNode, JsonObject>> {
    const job = this.job(runId);
    job.controller.signal.throwIfAborted();
    const result = await this.ctx.agentsRuntime.run({ id: `company-plan:${runId}`, agentId: this.settings.plannerAgentId, input: [
      '你是公司任务规划负责人。将用户目标拆解成有依赖关系的可执行 DAG。不要执行节点任务。',
      '最终回复必须仅为 JSON 对象，不要 Markdown。格式：',
      '{"nodes":[{"id":"task-1","data":{"agentId":"worker","instruction":"具体任务及验收条件","input":{}}}],"edges":[{"id":"dependency-1","source":"task-1","target":"task-2","data":{}}]}',
      `执行 Agent 只能从以下列表选择：${JSON.stringify(this.settings.workerAgentIds)}。至少 1 个节点，最多 ${this.settings.maxNodes} 个节点。`,
      '所有节点和边 ID 唯一，不能有环，所有边必须引用已有节点。下游会收到上游 output，节点 input 不需要虚构上游结果。',
      JSON.stringify({ runId, goal }),
    ].join('\n') }, { signal: job.controller.signal });
    job.controller.signal.throwIfAborted();
    if (result.error) throw new Error(`任务规划失败：${result.error}`);
    const graph = validatePlannedDag(JSON.parse(result.finalMessage));
    if (!graph.nodes.length || graph.nodes.length > this.settings.maxNodes) throw new Error('规划节点数量超出限制');
    if (graph.nodes.some(node => !this.settings.workerAgentIds.includes(node.data.agentId))) throw new Error('规划使用了未授权的执行 Agent');
    return graph;
  }
  private async execute(request: AgentExecutionInput) {
    const job = this.job(request.runId);
    job.controller.signal.throwIfAborted();
    // context 此时已将节点置为 RUNNING，先发布画面再启动 CLI。
    await this.refresh(request.runId);
    job.controller.signal.throwIfAborted();
    return this.ctx.agentsRuntime.execute(request, { signal: job.controller.signal });
  }
  private async process(runId: string, goal: AgentGoal): Promise<void> {
    const job = this.job(runId);
    try {
      const plan = await this.runtime.decomposeGoal(runId, goal);
      this.change(runId, { status: job.controller.signal.aborted ? 'CANCELLED' : 'RUNNING', run: plan });
      job.controller.signal.throwIfAborted();
      for (const nodeId of topologicalOrder(plan.graph)) {
        job.controller.signal.throwIfAborted();
        if ((await this.runtime.getSnapshot(runId)).states[nodeId].status === 'READY') {
          await this.runtime.executeNode(runId, nodeId);
          await this.refresh(runId);
        }
      }
      job.controller.signal.throwIfAborted();
      const final = await this.refresh(runId);
      const succeeded = Object.values(final.states).every(state => state.status === 'SUCCEEDED');
      this.change(runId, { status: succeeded ? 'SUCCEEDED' : 'FAILED', ...(!succeeded ? { error: '部分节点失败；依赖失败节点的下游保持阻塞，请查看节点反馈' } : {}) });
    } catch (error) {
      if (job.snapshot.run) { try { await this.refresh(runId); } catch { /* 保留最近有效快照 */ } }
      this.change(runId, { status: job.controller.signal.aborted ? 'CANCELLED' : 'FAILED', error: job.controller.signal.aborted ? '任务已停止' : errorMessage(error) });
    }
  }
}
export const companyPlugin = {
  name: 'company', inject: ['agentsRuntime'], provide: ['company', 'agentsDag'],
  apply(ctx: Context, options: CompanyOptions) { return new CompanyService(ctx, options); },
};
