/** 动态 DAG 运行时：确定性调度、版本提交、外部执行边界与恢复。 */
import { randomUUID } from 'node:crypto';
import { applyOperations, canonical, descendants, validateGraph } from './graph.js';
import { decisionSchema, goalSchema, jsonSchema, proposalSchema, resultSchema, type Attempt, type ExecutionContext, type ExecutionResult, type ExecutorPort, type Graph, type Json, type PlanDecision, type PlannerPort, type PlanProposal, type Policy, type RunSnapshot, type RuntimeEvent, type RuntimeStore, type StoreTransaction, type TaskRun, type TaskSpec } from './types.js';

export const defaultPolicy: Policy = { maxConcurrentTasks: 4, maxReplans: 10, noProgressLimit: 3, plannerTimeoutMs: 120_000 };
export interface RuntimeOptions { store: RuntimeStore; planner: PlannerPort; executors: Record<string, ExecutorPort>; policy?: Partial<Policy>; leaseMs?: number }
type Active = { runId: string; task: TaskSpec; controller: AbortController };

/** 获取当前有效的节点代次，历史记录始终保留。 */
export function currentTask(state: RunSnapshot, taskId: string): TaskRun | undefined { return state.tasks.findLast(task => task.taskId === taskId && task.valid); }
/** 获取当前版本的不可变任务图。 */
export function currentGraph(state: RunSnapshot): Graph | undefined { return state.plans.find(plan => plan.version === state.planVersion)?.graph; }
/** 取得错误的简明说明。 */
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
/** 判断运行是否已经终结。 */
function terminal(state: RunSnapshot): boolean { return state.status === 'SUCCEEDED' || state.status === 'FAILED'; }

/** 运行时实例是唯一调度者，宿主扩展只能通过声明的端口返回结果。 */
export class Runtime {
  private readonly owner = randomUUID();
  private readonly fence: number;
  private readonly leaseMs: number;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private stopped = false;
  private initialized = false;
  private queued = new Set<string>();
  private active = new Map<string, Active>();
  private planning = new Map<string, AbortController>();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  readonly policy: Policy;
  /** 建立租约，持久化恢复完成前不派发新任务。 */
  constructor(private readonly options: RuntimeOptions) {
    this.policy = { ...defaultPolicy, ...options.policy };
    for (const value of Object.values(this.policy)) if (!Number.isInteger(value) || value <= 0) throw new Error('策略参数必须为正整数');
    this.leaseMs = options.leaseMs ?? 30_000;
    this.fence = options.store.acquire(this.owner, this.leaseMs);
    this.heartbeat = setInterval(() => {
      try { options.store.renew(this.owner, this.fence, this.leaseMs); }
      catch { this.stopped = true; for (const work of this.active.values()) work.controller.abort(); for (const work of this.planning.values()) work.abort(); clearInterval(this.heartbeat); }
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    this.heartbeat.unref();
  }
  /** 对所有非终结执行进行核对；未知执行绝不自动重发。 */
  async initialize(): Promise<void> {
    for (const original of this.options.store.list()) {
      if (terminal(original) || original.status === 'CREATED') continue;
      const keepPaused = original.status === 'PAUSED' || original.status === 'PAUSING';
      const keepWaiting = original.status === 'WAITING_INPUT';
      this.change(original.id, tx => { tx.state.status = 'RECOVERING'; tx.emit('run.recovering'); });
      for (const attempt of original.attempts.filter(item => ['DISPATCHED', 'RUNNING', 'UNKNOWN'].includes(item.status))) {
        const state = this.getSnapshot(original.id);
        if (!currentTask(state, attempt.taskId)?.attemptIds.includes(attempt.id)) continue;
        const executor = this.options.executors[attempt.executor];
        try {
          const recovery = executor ? await executor.reconcile(structuredClone(attempt)) : { status: 'UNKNOWN' as const, reason: '执行器不可用' };
          if (recovery.status === 'COMPLETED') this.finish(original.id, attempt.id, resultSchema.parse(recovery.result));
          else if (recovery.status === 'RUNNING') {
            const task = currentGraph(state)!.tasks.find(item => item.id === attempt.taskId)!;
            const controller = new AbortController(); this.active.set(attempt.id, { runId: state.id, task, controller });
            this.change(state.id, tx => { const found = tx.state.attempts.find(item => item.id === attempt.id)!; found.status = 'RUNNING'; currentTask(tx.state, task.id)!.status = 'RUNNING'; tx.emit('attempt.reattached', { attemptId: attempt.id }); });
            void this.observe(original.id, attempt.id, () => recovery.observe(this.context(original.id, attempt.id, controller.signal)));
          } else this.unknown(original.id, attempt.id, recovery.reason);
        } catch (error) { this.unknown(original.id, attempt.id, message(error)); }
      }
      this.change(original.id, tx => {
        const unresolved = tx.state.tasks.some(task => task.valid && task.status === 'UNKNOWN');
        tx.state.status = original.status === 'PAUSING' ? 'PAUSING' : keepPaused ? 'PAUSED' : unresolved || keepWaiting ? 'WAITING_INPUT' : 'RUNNING';
        tx.state.needsEvaluation = true; tx.state.trigger = 'recovered'; tx.emit('run.recovered', { status: tx.state.status });
      });
    }
    this.initialized = true; this.scheduleAll();
  }
  /** 统一事务入口，提交后才通知订阅者。 */
  private change<T>(runId: string, action: (tx: StoreTransaction) => T, command?: { id: string; fingerprint: string }): T {
    if (this.stopped) throw new Error('运行时已关闭或租约失效');
    const before = this.options.store.read(runId).lastEventSeq;
    const result = this.options.store.transact(runId, this.fence, action, command);
    for (const event of this.options.store.events(runId, before)) for (const listener of this.listeners) queueMicrotask(() => { if (this.listeners.has(listener)) { try { listener(event); } catch { /* 观察者错误不回滚已提交的业务状态。 */ } } });
    return result;
  }
  /** 生成含请求参数的幂等标识。 */
  private command(method: string, runId: string, args: unknown, commandId: string = randomUUID()) { return { id: commandId, fingerprint: canonical({ method, runId, args }) }; }
  /** 创建目标运行；初始图可由宿主直接提供。 */
  createRun(input: { goal: unknown; initialPlan?: unknown; parentRunId?: string }, commandId: string = randomUUID()): string {
    if (this.stopped) throw new Error('运行时已关闭');
    const goal = goalSchema.parse(input.goal);
    const graph = input.initialPlan ? validateGraph(input.initialPlan, new Set(Object.keys(this.options.executors))) : undefined;
    const now = new Date().toISOString();
    const state: RunSnapshot = { id: randomUUID(), goal, status: 'CREATED', createdAt: now, updatedAt: now, stateRevision: 0, lastEventSeq: 0, planVersion: graph ? 1 : 0,
      plans: graph ? [{ version: 1, parentVersion: null, graph, reason: '宿主提供初始图', evidenceRefs: [], createdAt: now }] : [],
      tasks: graph?.tasks.map(task => this.newTask(task, 1)) ?? [], attempts: [], artifacts: [], needsEvaluation: !graph, trigger: 'initial',
      replanCount: 0, noProgressCount: 0, policy: this.policy, pendingReruns: [], resumeAfterDrain: false, layout: {}, userInputs: [], parentRunId: input.parentRunId };
    return this.options.store.create(state, this.fence, commandId, canonical({ method: 'createRun', input }));
  }
  /** 创建新的节点代次。 */
  private newTask(task: TaskSpec, generation: number): TaskRun { return { taskId: task.id, generation, specRevision: task.revision, status: 'PENDING', valid: true, artifactIds: [], attemptIds: [] }; }
  /** 启动尚未运行的目标。 */
  start(runId: string, commandId?: string): void {
    this.change(runId, tx => { if (tx.state.status !== 'CREATED') throw new Error('只有新建运行可以启动'); tx.state.status = 'RUNNING'; tx.emit('run.started'); }, this.command('start', runId, {}, commandId)); this.schedule(runId);
  }
  /** 停止派发，等待当前外部调用到达安全边界。 */
  pause(runId: string, commandId?: string): void {
    this.change(runId, tx => {
      if (terminal(tx.state)) throw new Error('已结束运行不能暂停');
      tx.state.status = this.countActive(runId) || this.planning.has(runId) ? 'PAUSING' : 'PAUSED'; tx.state.resumeAfterDrain = false;
      tx.emit('run.pause_requested', { status: tx.state.status });
    }, this.command('pause', runId, {}, commandId)); this.schedule(runId);
  }
  /** 从暂停或等待状态恢复；未知执行必须先核对。 */
  resume(runId: string, commandId?: string): void {
    this.change(runId, tx => {
      if (!['PAUSED', 'WAITING_INPUT'].includes(tx.state.status)) throw new Error('当前运行不可恢复');
      if (tx.state.tasks.some(task => task.valid && task.status === 'UNKNOWN')) throw new Error('存在状态未知的执行，请先核对');
      for (const task of tx.state.tasks) if (task.valid && task.status === 'INTERRUPTED') task.status = 'PENDING';
      this.refreshBlocked(tx.state);
      tx.state.status = tx.state.pendingReruns.length ? 'PAUSING' : 'RUNNING';
      if (tx.state.pendingReruns.length) tx.state.resumeAfterDrain = true;
      tx.state.reason = undefined; tx.state.needsEvaluation = true; tx.state.trigger = 'resumed'; tx.emit('run.resumed');
    }, this.command('resume', runId, {}, commandId)); this.schedule(runId);
  }
  /** 请求支持中断的执行器停止，最终状态由执行器回报决定。 */
  interrupt(runId: string, commandId?: string): void {
    const targets = [...this.active.entries()].filter(([, item]) => item.runId === runId);
    this.change(runId, tx => {
      if (!targets.length) throw new Error('没有可中断的执行');
      if (targets.some(([, item]) => !this.options.executors[item.task.executor].capabilities?.interrupt)) throw new Error('执行器不支持中断');
      tx.state.status = 'PAUSING'; tx.state.resumeAfterDrain = false; tx.emit('run.interrupt_requested');
    }, this.command('interrupt', runId, {}, commandId));
    for (const [, work] of targets) work.controller.abort();
  }
  /** 在安全边界重建节点及后继代次，不覆盖任何旧记录。 */
  rerunTask(runId: string, taskId: string, commandId?: string): void {
    this.change(runId, tx => {
      if (!currentTask(tx.state, taskId)) throw new Error('节点不存在');
      const affected = descendants(currentGraph(tx.state), [taskId]);
      if (tx.state.tasks.some(task => task.valid && affected.has(task.taskId) && task.status === 'UNKNOWN')) throw new Error('未知执行不能重跑，请先核对');
      tx.state.resumeAfterDrain = !['PAUSED', 'PAUSING'].includes(tx.state.status);
      if (!tx.state.pendingReruns.includes(taskId)) tx.state.pendingReruns.push(taskId);
      tx.state.status = 'PAUSING'; tx.emit('task.rerun_requested', { taskId });
    }, this.command('rerunTask', runId, { taskId }, commandId)); this.schedule(runId);
  }
  /** 创建全新运行，原运行与历史均保持不变。 */
  restartRun(runId: string, commandId: string = randomUUID()): string {
    const old = this.getSnapshot(runId);
    if (old.tasks.some(task => task.valid && task.status === 'UNKNOWN')) throw new Error('未知执行必须先核对，不能整体重跑');
    const id = this.createRun({ goal: old.goal, initialPlan: currentGraph(old), parentRunId: runId }, commandId);
    if (this.getSnapshot(id).status === 'CREATED') this.start(id, `${commandId}:start`); return id;
  }
  /** 保存用户补充并触发边界评估，用户暂停意图保持不变。 */
  addInput(runId: string, text: string, commandId?: string): void {
    if (typeof text !== 'string' || !text.trim()) throw new Error('补充内容不能为空');
    this.change(runId, tx => {
      if (terminal(tx.state)) throw new Error('已结束运行请先重跑');
      tx.state.userInputs ??= []; tx.state.userInputs.push({ text, createdAt: new Date().toISOString() });
      tx.state.needsEvaluation = true; tx.state.trigger = 'user_input';
      if (tx.state.status === 'WAITING_INPUT') tx.state.status = 'RUNNING';
      tx.emit('input.received', { text });
    }, this.command('addInput', runId, { text }, commandId)); this.schedule(runId);
  }
  /** 宿主主动提交计划；仅在无外部调用的安全边界接收。 */
  proposePlan(runId: string, input: PlanProposal, commandId?: string): void {
    const proposal = proposalSchema.parse(input);
    this.change(runId, tx => {
      if (this.countActive(runId) || this.planning.has(runId)) throw new Error('请等待安全边界后提交计划');
      if (terminal(tx.state)) throw new Error('已结束运行请先重跑');
      this.commitPlan(tx, proposal, false); tx.state.needsEvaluation = false;
      if (tx.state.status === 'WAITING_INPUT') tx.state.status = 'PAUSED';
    }, this.command('proposePlan', runId, proposal, commandId)); this.schedule(runId);
  }
  /** 人工核对外部结果，仅允许关闭未知执行，不触发重新执行。 */
  resolveAttempt(runId: string, attemptId: string, result: ExecutionResult, commandId?: string): void {
    const parsed = resultSchema.parse(result);
    this.change(runId, tx => {
      const attempt = tx.state.attempts.find(item => item.id === attemptId);
      if (!attempt || attempt.status !== 'UNKNOWN') throw new Error('仅可核对未知执行');
      this.applyResult(tx, attemptId, parsed); tx.emit('attempt.resolved', { attemptId });
    }, this.command('resolveAttempt', runId, { attemptId, result: parsed }, commandId));
    this.scheduleAll();
  }
  /** 仅持久化画布坐标，不生成新的计划版本。 */
  saveLayout(runId: string, layout: Record<string, { x: number; y: number }>): void {
    for (const position of Object.values(layout)) if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('布局坐标无效');
    this.change(runId, tx => { tx.state.layout = structuredClone(layout); tx.emit('layout.saved'); });
  }
  /** 返回数据库快照，调用者修改它不会影响运行时。 */
  getSnapshot(runId: string, eventSeq?: number): RunSnapshot { return eventSeq === undefined ? this.options.store.read(runId) : this.options.store.readAt(runId, eventSeq); }
  /** 列出运行历史。 */
  listRuns(): RunSnapshot[] { return this.options.store.list(); }
  /** 返回连续的持久化事件。 */
  listEvents(runId: string, after = 0, limit = 1000): RuntimeEvent[] { return this.options.store.events(runId, after, limit); }
  /** 订阅提交后的通知；断线补读应使用 listEvents。 */
  subscribe(listener: (event: RuntimeEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** 读取运行所属的产物，禁止跨运行猜测引用。 */
  readArtifact(runId: string, artifactId: string): Uint8Array { const artifact = this.getSnapshot(runId).artifacts.find(item => item.id === artifactId); if (!artifact) throw new Error('产物不存在'); return this.options.store.readArtifact(artifact); }
  /** 返回前端可用操作，能力以服务端实际状态为准。 */
  controls(runId: string) {
    const state = this.getSnapshot(runId); const work = [...this.active.values()].filter(item => item.runId === runId);
    return { start: state.status === 'CREATED', pause: ['RUNNING', 'PLANNING', 'EVALUATING', 'WAITING_INPUT'].includes(state.status),
      resume: ['PAUSED', 'WAITING_INPUT'].includes(state.status) && !state.tasks.some(task => task.valid && task.status === 'UNKNOWN'),
      interrupt: work.length > 0 && work.every(item => this.options.executors[item.task.executor].capabilities?.interrupt),
      rerun: state.status !== 'RECOVERING', restart: !state.tasks.some(task => task.valid && task.status === 'UNKNOWN') };
  }
  /** 使所有运行获得新的调度机会，释放跨运行资源锁。 */
  private scheduleAll(): void { if (!this.stopped && this.initialized) for (const run of this.listRuns()) this.schedule(run.id); }
  /** 合并同一轮唤醒，防止递归调度。 */
  private schedule(runId: string): void {
    if (this.stopped || !this.initialized || this.queued.has(runId)) return;
    this.queued.add(runId); queueMicrotask(() => {
      this.queued.delete(runId); if (this.stopped) return;
      try { this.advance(runId); } catch (error) {
        try { this.change(runId, tx => { tx.state.status = 'WAITING_INPUT'; tx.state.reason = message(error); tx.emit('runtime.error', { reason: message(error) }); }); } catch { /* 租约丢失后禁止再次回写。 */ }
      }
    });
  }
  /** 统计本实例仍在观察的外部执行。 */
  private countActive(runId: string): number { return [...this.active.values()].filter(item => item.runId === runId).length; }
  /** 推进一个运行；评估前始终等待所有在途任务结束。 */
  private advance(runId: string): void {
    let state = this.getSnapshot(runId);
    if (state.status === 'PAUSING') {
      if (this.countActive(runId) || this.planning.has(runId)) return;
      const rerunAffected = descendants(currentGraph(state), state.pendingReruns);
      if (state.tasks.some(task => task.valid && task.status === 'UNKNOWN' && rerunAffected.has(task.taskId))) {
        this.change(runId, tx => { tx.state.status = tx.state.resumeAfterDrain ? 'WAITING_INPUT' : 'PAUSED'; tx.state.reason = '待重跑任务存在未知执行，请先核对'; tx.emit('run.waiting', { reason: tx.state.reason }); }); return;
      }
      this.change(runId, tx => {
        if (tx.state.pendingReruns.length) {
          this.invalidate(tx.state, descendants(currentGraph(tx.state), tx.state.pendingReruns));
          tx.emit('tasks.invalidated', { taskIds: tx.state.pendingReruns }); tx.state.pendingReruns = [];
          tx.state.needsEvaluation = false; tx.state.reason = undefined;
        }
        tx.state.status = tx.state.resumeAfterDrain ? 'RUNNING' : 'PAUSED'; tx.state.resumeAfterDrain = false; tx.emit('run.drained', { status: tx.state.status });
      });
      state = this.getSnapshot(runId);
    }
    if (state.status !== 'RUNNING' || this.planning.has(runId)) return;
    if (state.tasks.some(task => task.valid && task.status === 'UNKNOWN')) { this.wait(runId, '存在未知执行，需要核对'); return; }
    if (state.needsEvaluation || !state.planVersion) { if (!this.countActive(runId)) this.evaluate(runId); return; }
    const graph = currentGraph(state)!;
    const runnable = graph.tasks.filter(task => {
      const current = currentTask(state, task.id)!;
      return ['PENDING', 'READY'].includes(current.status) && task.dependencies.every(id => currentTask(state, id)?.status === 'SUCCEEDED');
    });
    for (const task of runnable) {
      if (this.active.size >= this.policy.maxConcurrentTasks || this.countActive(runId) >= state.policy.maxConcurrentTasks) break;
      if (!this.resourceAvailable(task)) continue;
      this.dispatch(runId, task);
    }
    state = this.getSnapshot(runId);
    if (!this.countActive(runId) && !runnable.length) {
      this.change(runId, tx => { tx.state.needsEvaluation = true; tx.state.trigger = 'frontier_exhausted'; tx.emit('evaluation.requested'); }); this.schedule(runId);
    }
  }
  /** 未声明隔离的执行器持有全局独占锁，资源名在所有运行之间共享。 */
  private resourceAvailable(task: TaskSpec): boolean {
    const isolated = this.options.executors[task.executor].capabilities?.resourceIsolation;
    // 无法确认外部执行已经结束时，继续保留它占用的资源锁。
    for (const run of this.listRuns()) for (const unknown of run.attempts.filter(item => item.status === 'UNKNOWN')) {
      if (!isolated || !this.options.executors[unknown.executor]?.capabilities?.resourceIsolation || unknown.input.task.resources.some(resource => task.resources.includes(resource))) return false;
    }
    if (!isolated) return !this.active.size;
    for (const work of this.active.values()) {
      if (!this.options.executors[work.task.executor].capabilities?.resourceIsolation) return false;
      if (work.task.resources.some(resource => task.resources.includes(resource))) return false;
    }
    return true;
  }
  /** 先提交派发意图和输入，再进入外部执行器。 */
  private dispatch(runId: string, task: TaskSpec): void {
    const attemptId = randomUUID(); const executor = this.options.executors[task.executor];
    this.change(runId, tx => {
      const current = currentTask(tx.state, task.id)!; const dependencies: Attempt['input']['dependencies'] = {};
      for (const id of task.dependencies) {
        const dependency = currentTask(tx.state, id)!;
        if (dependency.status !== 'SUCCEEDED') throw new Error('依赖状态已变化');
        for (const artifactId of dependency.artifactIds) if (!this.options.store.hasArtifact(tx.state.artifacts.find(item => item.id === artifactId)!)) throw new Error('依赖产物缺失');
        dependencies[id] = { generation: dependency.generation, specRevision: dependency.specRevision, attemptId: dependency.attemptIds.at(-1)!, output: dependency.output ?? {}, artifactIds: dependency.artifactIds };
      }
      const previous = tx.state.attempts.findLast(item => item.taskId === task.id && item.generation === current.generation && item.status === 'INTERRUPTED' && item.input.task.revision === task.revision);
      const canResume = executor.capabilities?.checkpoint && previous?.checkpoint !== undefined && canonical(previous.input.dependencies) === canonical(dependencies);
      const attempt: Attempt = { id: attemptId, runId, taskId: task.id, generation: current.generation, planVersion: tx.state.planVersion, executor: task.executor,
        status: 'DISPATCHED', input: { goal: tx.state.goal, task, dependencies, userInputs: tx.state.userInputs ?? [] }, startedAt: new Date().toISOString(),
        ...(canResume ? { checkpoint: previous!.checkpoint, resumedFrom: previous!.id } : {}) };
      current.status = 'RUNNING'; current.blockedReason = undefined; current.attemptIds.push(attemptId); tx.state.attempts.push(attempt);
      tx.emit('task.ready', { taskId: task.id }); tx.emit('attempt.dispatched', { taskId: task.id, attemptId, generation: current.generation });
    });
    const controller = new AbortController(); this.active.set(attemptId, { runId, task, controller });
    this.change(runId, tx => { tx.state.attempts.find(item => item.id === attemptId)!.status = 'RUNNING'; tx.emit('attempt.started', { attemptId }); });
    const attempt = this.getSnapshot(runId).attempts.find(item => item.id === attemptId)!;
    void this.observe(runId, attemptId, () => executor.execute({ attemptId, runId, taskId: task.id, generation: attempt.generation, input: structuredClone(attempt.input), checkpoint: attempt.checkpoint }, this.context(runId, attemptId, controller.signal)));
  }
  /** 观察外部调用；异常不等同于确认失败，因此按未知状态处理。 */
  private async observe(runId: string, attemptId: string, action: () => Promise<ExecutionResult>): Promise<void> {
    try { const result = await action(); if (!this.stopped) this.finish(runId, attemptId, resultSchema.parse(result)); }
    catch (error) { if (!this.stopped) { try { this.unknown(runId, attemptId, message(error)); } catch { /* 租约失效时保留待恢复记录。 */ } } }
    finally { this.active.delete(attemptId); this.scheduleAll(); }
  }
  /** 为执行器创建受代次和令牌约束的回报接口。 */
  private context(runId: string, attemptId: string, signal: AbortSignal): ExecutionContext {
    /** 仅允许当前仍运行的执行更新自身记录。 */
    const update = (type: string, apply: (attempt: Attempt, tx: StoreTransaction) => void) => {
      this.change(runId, tx => {
        const attempt = tx.state.attempts.find(item => item.id === attemptId);
        if (!attempt || !['DISPATCHED', 'RUNNING'].includes(attempt.status) || !currentTask(tx.state, attempt.taskId)?.attemptIds.includes(attemptId)) throw new Error('执行回报已过期');
        apply(attempt, tx); tx.emit(type, { attemptId, taskId: attempt.taskId });
      });
    };
    return {
      signal,
      reportProgress: (text, percent) => { if (percent !== undefined && (!Number.isFinite(percent) || percent < 0 || percent > 100)) throw new Error('进度必须介于 0 与 100'); update('attempt.progress', attempt => { attempt.progress = { message: text, percent }; }); },
      saveHandle: handle => { const value = jsonSchema.parse(handle); update('attempt.handle_saved', attempt => { attempt.externalHandle = value; }); },
      saveCheckpoint: checkpoint => { const value = jsonSchema.parse(checkpoint); update('attempt.checkpoint_saved', attempt => { attempt.checkpoint = value; }); },
      saveArtifact: (name, content, mediaType = 'text/plain') => {
        if (!name.trim()) throw new Error('产物名称不能为空');
        const artifact = this.options.store.writeArtifact(runId, attemptId, name, content, mediaType);
        update('artifact.created', (_attempt, tx) => { tx.state.artifacts.push(artifact); }); return artifact;
      },
    };
  }
  /** 提交执行结果，并触发下一次一致快照评估。 */
  private finish(runId: string, attemptId: string, result: ExecutionResult): void { this.change(runId, tx => { this.applyResult(tx, attemptId, result); }); }
  /** 校验输出约定、产物归属与当前代次，拒绝旧执行覆盖当前结果。 */
  private applyResult(tx: StoreTransaction, attemptId: string, result: ExecutionResult): void {
    const attempt = tx.state.attempts.find(item => item.id === attemptId); if (!attempt) throw new Error('执行不存在');
    const task = currentTask(tx.state, attempt.taskId);
    if (!task || task.generation !== attempt.generation || !['DISPATCHED', 'RUNNING', 'UNKNOWN'].includes(attempt.status)) { tx.emit('attempt.result_ignored', { attemptId }); return; }
    for (const id of result.artifactIds) {
      const artifact = tx.state.artifacts.find(item => item.id === id && item.attemptId === attemptId);
      if (!artifact || !this.options.store.hasArtifact(artifact)) throw new Error('执行返回无效产物引用');
    }
    if (result.status === 'SUCCEEDED') for (const name of attempt.input.task.outputs) if (!(name in result.output)) throw new Error(`缺少约定输出：${name}`);
    attempt.status = result.status; attempt.endedAt = new Date().toISOString(); attempt.result = result; attempt.error = result.error;
    task.status = result.status; task.output = result.output; task.artifactIds = result.artifactIds; task.blockedReason = result.error;
    tx.state.needsEvaluation = true; tx.state.trigger = 'task_completed';
    if (result.status === 'SUCCEEDED') tx.state.noProgressCount = 0;
    tx.emit('attempt.completed', { taskId: task.taskId, attemptId, status: result.status });
    this.refreshBlocked(tx.state);
  }
  /** 标记未能确认的执行，停止自动推进并保留所有证据。 */
  private unknown(runId: string, attemptId: string, reason: string): void {
    this.change(runId, tx => {
      const attempt = tx.state.attempts.find(item => item.id === attemptId)!; attempt.status = 'UNKNOWN'; attempt.error = reason;
      const task = currentTask(tx.state, attempt.taskId); if (task) { task.status = 'UNKNOWN'; task.blockedReason = reason; }
      if (!['PAUSED', 'PAUSING', 'RECOVERING'].includes(tx.state.status)) tx.state.status = 'WAITING_INPUT';
      tx.state.reason = `执行状态未知：${reason}`; this.refreshBlocked(tx.state); tx.emit('attempt.unknown', { attemptId, reason });
    });
  }
  /** 更新未执行节点的依赖阻塞说明。 */
  private refreshBlocked(state: RunSnapshot): void {
    for (const spec of currentGraph(state)?.tasks ?? []) {
      const task = currentTask(state, spec.id)!;
      if (['PENDING', 'READY'].includes(task.status)) {
        const blockers = spec.dependencies.filter(id => currentTask(state, id)?.status !== 'SUCCEEDED');
        task.status = blockers.length ? 'PENDING' : 'READY'; task.blockedReason = blockers.length ? `等待依赖：${blockers.join('、')}` : undefined;
      }
    }
  }
  /** 在边界调用规划器，超时只停止规划，不修改执行结果。 */
  private evaluate(runId: string): void {
    const controller = new AbortController(); this.planning.set(runId, controller);
    this.change(runId, tx => { tx.state.status = tx.state.planVersion ? 'EVALUATING' : 'PLANNING'; tx.emit('evaluation.started', { trigger: tx.state.trigger }); });
    const snapshot = this.getSnapshot(runId);
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('规划器超时')); }, snapshot.policy.plannerTimeoutMs); });
    void Promise.race([Promise.resolve().then(() => this.options.planner.evaluate(structuredClone(snapshot), snapshot.trigger, controller.signal)), timeout])
      .then(input => {
        if (this.stopped) return;
        const decision = decisionSchema.parse(input); const current = this.getSnapshot(runId);
        if (current.status === 'PAUSING' || current.stateRevision !== snapshot.stateRevision) {
          this.change(runId, tx => { if (tx.state.status !== 'PAUSING') tx.state.status = 'RUNNING'; tx.state.needsEvaluation = true; tx.emit('evaluation.discarded', { reason: '评估期间状态发生变化' }); }); return;
        }
        this.change(runId, tx => { this.applyDecision(tx, decision); });
      }).catch(error => { if (!this.stopped) { try { this.wait(runId, message(error)); } catch { /* 旧实例不再拥有写入权限。 */ } } })
      .finally(() => { clearTimeout(timer!); this.planning.delete(runId); this.schedule(runId); });
  }
  /** 应用已校验的规划决策，失败结果不会被 CONTINUE 隐式重试。 */
  private applyDecision(tx: StoreTransaction, decision: PlanDecision): void {
    const state = tx.state;
    tx.emit('evaluation.decided', decision as unknown as Json);
    state.needsEvaluation = false; state.status = 'RUNNING'; state.reason = undefined;
    if (decision.type === 'WAIT') { state.status = 'WAITING_INPUT'; state.reason = decision.reason; return; }
    if (decision.type === 'COMPLETE') {
      const graph = currentGraph(state);
      if (!graph || graph.tasks.some(task => task.required && currentTask(state, task.id)?.status !== 'SUCCEEDED')) throw new Error('必需任务尚未成功，不能完成目标');
      const validEvidence = new Set<string>();
      for (const task of state.tasks.filter(item => item.valid && item.status === 'SUCCEEDED')) {
        validEvidence.add(task.attemptIds.at(-1)!);
        for (const id of task.artifactIds) { const artifact = state.artifacts.find(item => item.id === id)!; if (!this.options.store.hasArtifact(artifact)) throw new Error('完成验收所需产物缺失'); validEvidence.add(id); }
      }
      if (decision.evidenceRefs.some(id => !validEvidence.has(id))) throw new Error('完成验收引用了无效或过期证据');
      state.status = 'SUCCEEDED'; state.reason = decision.reason; tx.emit('run.completed', { reason: decision.reason, evidenceRefs: decision.evidenceRefs }); return;
    }
    if (decision.type === 'REVISE') {
      if (state.planVersion && state.replanCount >= state.policy.maxReplans) { state.status = 'WAITING_INPUT'; state.reason = '自动改图次数已达上限'; return; }
      const changed = this.commitPlan(tx, decision.proposal, true);
      if (changed && state.planVersion > 1) state.replanCount++;
      state.noProgressCount++;
    }
    if (!state.planVersion) throw new Error('初始评估必须生成任务图');
    this.refreshBlocked(state);
    const canRun = state.tasks.some(task => task.valid && task.status === 'READY');
    if (!canRun || state.noProgressCount >= state.policy.noProgressLimit) {
      state.status = 'WAITING_INPUT'; state.reason = canRun ? '连续改图未取得执行进展' : '没有可执行任务，需要调整计划或提交验收结果';
    }
  }
  /** 将候选图原子安装为新版本，并计算旧结果失效范围。 */
  private commitPlan(tx: StoreTransaction, proposal: PlanProposal, automatic: boolean): boolean {
    const state = tx.state;
    // 事务入口已递增 revision，因此提案应对应上一版状态。
    if (proposal.basePlanVersion !== state.planVersion || proposal.baseStateRevision !== state.stateRevision - 1) throw new Error('STALE_PLAN：候选计划已过期');
    const old = currentGraph(state);
    const next = validateGraph(applyOperations(old, proposal), new Set(Object.keys(this.options.executors)));
    const oldById = new Map(old?.tasks.map(task => [task.id, task])); const seeds = new Set<string>();
    for (const task of next.tasks) {
      const previous = oldById.get(task.id);
      if (!previous) {
        const historic = Math.max(0, ...state.plans.flatMap(plan => plan.graph.tasks.filter(item => item.id === task.id).map(item => item.revision)));
        task.revision = historic + 1; seeds.add(task.id);
      } else if (canonical({ ...task, revision: 0 }) !== canonical({ ...previous, revision: 0 })) { task.revision = previous.revision + 1; seeds.add(task.id); }
      else task.revision = previous.revision;
    }
    for (const task of old?.tasks ?? []) if (!next.tasks.some(item => item.id === task.id)) seeds.add(task.id);
    if (!seeds.size) { tx.emit('plan.unchanged'); return false; }
    const affected = new Set([...descendants(old, seeds), ...descendants(next, seeds)]);
    if (state.tasks.some(task => task.valid && task.status === 'UNKNOWN' && affected.has(task.taskId))) throw new Error('未知执行必须先核对，不能通过改图使其失效');
    const version = state.planVersion + 1;
    state.plans.push({ version, parentVersion: state.planVersion || null, graph: next, reason: proposal.reason, evidenceRefs: proposal.evidenceRefs, createdAt: new Date().toISOString() });
    state.planVersion = version; this.invalidate(state, affected); this.refreshBlocked(state);
    tx.emit('plan.committed', { version, reason: proposal.reason, affected: [...affected], automatic }); return true;
  }
  /** 废弃旧代次的有效性，为当前图中的受影响节点创建新代次。 */
  private invalidate(state: RunSnapshot, affected: Set<string>): void {
    for (const old of state.tasks) if (old.valid && affected.has(old.taskId)) old.valid = false;
    for (const spec of currentGraph(state)?.tasks ?? []) if (affected.has(spec.id)) {
      const generation = Math.max(0, ...state.tasks.filter(item => item.taskId === spec.id).map(item => item.generation)) + 1;
      state.tasks.push(this.newTask(spec, generation));
    }
    this.refreshBlocked(state);
  }
  /** 停止自动推进，保留用户暂停意图。 */
  private wait(runId: string, reason: string): void {
    this.change(runId, tx => { if (!['PAUSED', 'PAUSING'].includes(tx.state.status)) tx.state.status = 'WAITING_INPUT'; tx.state.reason = reason; tx.emit('run.waiting', { reason }); });
  }
  /** 正常关闭时先排空；abandon 用于宿主强制退出和恢复测试。 */
  async close(options: { abandon?: boolean } = {}): Promise<void> {
    if (!this.stopped && !options.abandon) {
      for (const run of this.listRuns()) if (['RUNNING', 'PLANNING', 'EVALUATING', 'PAUSING'].includes(run.status)) this.pause(run.id);
      while (this.active.size || this.planning.size) await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.stopped = true; clearInterval(this.heartbeat);
    for (const work of this.active.values()) work.controller.abort(); for (const work of this.planning.values()) work.abort();
    this.options.store.release(this.owner, this.fence); this.listeners.clear();
  }
}

/** 创建并恢复运行时，调用方应等待初始化完成后操作。 */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const runtime = new Runtime(options);
  try { await runtime.initialize(); return runtime; } catch (error) { await runtime.close({ abandon: true }); throw error; }
}
