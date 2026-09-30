/** 无外部服务的模拟适配器，用于集成测试、演示与宿主接入参考。 */
import { currentGraph, currentTask } from './runtime.js';
import { taskSchema, type ExecutionContext, type ExecutionRequest, type ExecutionResult, type ExecutorPort, type PlannerPort, type PlanDecision, type RunSnapshot, type TaskSpec } from './types.js';

/** 构建符合公共协议的任务定义。 */
export function makeTask(id: string, dependencies: string[] = [], overrides: Partial<TaskSpec> = {}): TaskSpec {
  return taskSchema.parse({ id, title: id, executor: 'fake', dependencies, outputs: ['summary'], ...overrides });
}
/** 可脚本化规划器；未提供决策时按依赖推进并验收。 */
export class FakePlanner implements PlannerPort {
  calls: RunSnapshot[] = [];
  /** 接收可选脚本，方便复现改图与异常决策。 */
  constructor(private readonly script?: (snapshot: RunSnapshot, call: number) => PlanDecision | Promise<PlanDecision>) {}
  /** 保存评估快照，默认仅在全部必需任务成功后完成。 */
  async evaluate(snapshot: RunSnapshot, _trigger: string, _signal: AbortSignal): Promise<PlanDecision> {
    this.calls.push(structuredClone(snapshot));
    if (this.script) return this.script(snapshot, this.calls.length);
    const graph = currentGraph(snapshot);
    if (!graph) return { type: 'REVISE', proposal: { basePlanVersion: 0, baseStateRevision: snapshot.stateRevision, operations: [{ type: 'addTask', task: makeTask('task') }], reason: '生成初始任务', evidenceRefs: [] } };
    if (graph.tasks.every(task => !task.required || currentTask(snapshot, task.id)?.status === 'SUCCEEDED')) {
      return { type: 'COMPLETE', reason: '任务与产物已验收', evidenceRefs: snapshot.tasks.filter(task => task.valid && task.status === 'SUCCEEDED').map(task => task.attemptIds.at(-1)!) };
    }
    if (snapshot.tasks.some(task => task.valid && ['FAILED', 'UNKNOWN'].includes(task.status))) return { type: 'WAIT', reason: '需要处理失败或未知任务' };
    return { type: 'CONTINUE', reason: '依赖满足后继续执行' };
  }
}

/** 模拟可中断执行器：定期上报进度、检查点，并生成本地产物。 */
export class FakeExecutor implements ExecutorPort {
  capabilities = { interrupt: true, checkpoint: true, idempotent: true, resourceIsolation: true };
  calls: ExecutionRequest[] = [];
  /** 设置每步耗时，测试可使用短间隔。 */
  constructor(private readonly stepMs = 10) {}
  /** 从保存的步骤继续，不依赖真实 Codex 或模型服务。 */
  async execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    this.calls.push(structuredClone(request)); context.saveHandle({ simulated: true, attemptId: request.attemptId });
    const previous = request.checkpoint as { step?: number } | undefined;
    for (let step = (previous?.step ?? 0) + 1; step <= 4; step++) {
      if (context.signal.aborted) return { status: 'INTERRUPTED', output: {}, artifactIds: [], error: '用户请求中断' };
      await new Promise<void>(resolve => {
        /** 清理定时器和事件监听，避免关闭后留下活动句柄。 */
        const done = () => { clearTimeout(timer); context.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, this.stepMs); context.signal.addEventListener('abort', done, { once: true });
      });
      if (context.signal.aborted) return { status: 'INTERRUPTED', output: {}, artifactIds: [], error: '用户请求中断' };
      context.reportProgress(['读取依赖上下文', '执行模拟任务', '检查任务输出', '保存验收产物'][step - 1], step * 25);
      context.saveCheckpoint({ step });
    }
    const output = Object.fromEntries(request.input.task.outputs.map(key => [key, `${request.input.task.title}已完成；输入来自 ${Object.keys(request.input.dependencies).join('、') || '目标定义'}`]));
    const artifact = context.saveArtifact(`${request.taskId}.json`, JSON.stringify({ taskId: request.taskId, output, input: request.input }, null, 2), 'application/json');
    return { status: 'SUCCEEDED', output, artifactIds: [artifact.id] };
  }
  /** 模拟任务只存在于旧进程内，进程退出后可确认中断。 */
  async reconcile(attempt: import('./types.js').Attempt) {
    if ((attempt.externalHandle as { simulated?: boolean } | undefined)?.simulated) return { status: 'COMPLETED' as const, result: { status: 'INTERRUPTED' as const, output: {}, artifactIds: [], error: '模拟进程已退出，可从检查点恢复' } };
    return { status: 'UNKNOWN' as const, reason: '未保存模拟执行句柄，无法确认派发情况' };
  }
}

/** 演示规划器：发现验收缺口后自动补充审查节点。 */
export class DemoPlanner extends FakePlanner {
  /** 安装可重复的规划脚本，展示实际图版本变化。 */
  constructor() {
    super(async snapshot => {
      if (!snapshot.planVersion) return { type: 'REVISE', proposal: { basePlanVersion: 0, baseStateRevision: snapshot.stateRevision, reason: '将目标拆分为范围、调研、方案和交付', evidenceRefs: [], operations: [
        makeTask('scope', [], { title: '明确目标与验收范围' }),
        makeTask('research', ['scope'], { title: '收集资料与约束' }),
        makeTask('draft', ['scope'], { title: '制定实施方案' }),
        makeTask('deliver', ['research', 'draft'], { title: '整理最终交付' }),
      ].map(task => ({ type: 'addTask' as const, task })) } };
      if (snapshot.planVersion === 1 && currentTask(snapshot, 'research')?.status === 'SUCCEEDED' && currentTask(snapshot, 'draft')?.status === 'SUCCEEDED') return {
        type: 'REVISE', proposal: { basePlanVersion: snapshot.planVersion, baseStateRevision: snapshot.stateRevision,
          reason: '调研和方案完成，补充交叉审查以覆盖验收条件', evidenceRefs: [currentTask(snapshot, 'research')!.attemptIds.at(-1)!], operations: [
            { type: 'addTask', task: makeTask('review', ['research', 'draft'], { title: '交叉审查与验收' }) },
            { type: 'updateTask', taskId: 'deliver', changes: { dependencies: ['review'] } },
          ] },
      };
      return new FakePlanner().evaluate(snapshot, '', new AbortController().signal);
    });
  }
}
