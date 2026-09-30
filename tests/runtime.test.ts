/** 内核集成测试：使用真实 SQLite 验证调度、事务和恢复。 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, currentTask, currentGraph, type Runtime } from '../src/runtime.js';
import { SqliteStore } from '../src/sqlite.js';
import { DemoPlanner, FakeExecutor, FakePlanner, makeTask } from '../src/testing.js';
import { validateGraph } from '../src/graph.js';
import type { ExecutionContext, ExecutionRequest, ExecutionResult, ExecutorPort, PlannerPort, RunSnapshot } from '../src/types.js';

/** 等待可观察状态，超时提供当前快照用于定位。 */
async function until(runtime: Runtime, id: string, condition: (state: RunSnapshot) => boolean, timeout = 3000): Promise<RunSnapshot> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const state = runtime.getSnapshot(id); if (condition(state)) return state; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`等待超时：${JSON.stringify(runtime.getSnapshot(id))}`);
}
/** 每个测试使用独立文件数据库，测试结束停止所有回调。 */
async function fixture(t: TestContext, executor: ExecutorPort = new FakeExecutor(), planner: PlannerPort = new FakePlanner()) {
  const directory = mkdtempSync(join(tmpdir(), 'goalsplit-'));
  const filename = join(directory, 'state.sqlite'); const store = new SqliteStore(filename);
  const runtime = await createRuntime({ store, planner, executors: { fake: executor } });
  t.after(async () => { await runtime.close({ abandon: true }); store.close(); });
  return { runtime, store, filename };
}
/** 手动结束外部任务，精确控制并行与暂停边界。 */
class GateExecutor implements ExecutorPort {
  capabilities = { resourceIsolation: true, interrupt: true, checkpoint: true };
  calls: ExecutionRequest[] = [];
  pending = new Map<string, { resolve: (result: ExecutionResult) => void; context: ExecutionContext }>();
  /** 保存外部句柄，等待测试显式完成。 */
  execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    this.calls.push(request); context.saveHandle({ id: request.attemptId });
    return new Promise(resolve => { this.pending.set(request.taskId, { resolve, context }); });
  }
  /** 交付一个可验收的模拟结果。 */
  finish(id: string): void { this.pending.get(id)!.resolve({ status: 'SUCCEEDED', output: { summary: `${id} ok` }, artifactIds: [] }); }
  /** 默认无法证明旧外部执行是否结束。 */
  async reconcile() { return { status: 'UNKNOWN' as const, reason: '外部状态待核对' }; }
}

test('图校验拒绝环、悬空依赖、重复 ID 和无效上下文引用', () => {
  const executors = new Set(['fake']);
  assert.throws(() => validateGraph({ tasks: [makeTask('a', ['b']), makeTask('b', ['a'])] }, executors), /环/);
  assert.throws(() => validateGraph({ tasks: [makeTask('a', ['missing'])] }, executors), /不存在/);
  assert.throws(() => validateGraph({ tasks: [makeTask('a'), makeTask('a')] }, executors), /重复/);
  assert.throws(() => validateGraph({ tasks: [makeTask('a'), makeTask('b', ['a'], { contextRefs: [{ taskId: 'a', output: 'absent' }] })] }, executors), /上下文/);
});

test('菱形依赖并行执行，下游等待全部依赖且只获得冻结输入', async t => {
  const executor = new GateExecutor(); const { runtime } = await fixture(t, executor);
  const id = runtime.createRun({ goal: { objective: '菱形任务' }, initialPlan: { tasks: [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['a']), makeTask('d', ['b', 'c'])] } });
  runtime.start(id); await until(runtime, id, state => state.attempts.length === 1); executor.finish('a');
  await until(runtime, id, state => state.attempts.length === 3);
  assert.deepEqual(executor.calls.map(call => call.taskId), ['a', 'b', 'c']);
  executor.finish('b'); await until(runtime, id, state => currentTask(state, 'b')?.status === 'SUCCEEDED');
  assert.equal(executor.calls.length, 3); executor.finish('c');
  await until(runtime, id, state => state.attempts.length === 4);
  assert.deepEqual(Object.keys(executor.calls[3].input.dependencies), ['b', 'c']);
  executor.finish('d'); const done = await until(runtime, id, state => state.status === 'SUCCEEDED');
  assert.equal(done.attempts.length, 4); assert.ok(done.attempts.every(attempt => attempt.status === 'SUCCEEDED'));
});

test('自动改图产生新版本、复用无关成功结果并补充审查', async t => {
  const { runtime } = await fixture(t, new FakeExecutor(1), new DemoPlanner());
  const id = runtime.createRun({ goal: { objective: '实现可验收的目标' } }); runtime.start(id);
  const done = await until(runtime, id, state => state.status === 'SUCCEEDED');
  assert.equal(done.plans.length, 2); assert.equal(done.replanCount, 1);
  assert.equal(done.attempts.filter(attempt => attempt.taskId === 'scope').length, 1);
  assert.equal(currentTask(done, 'deliver')?.generation, 2);
  assert.deepEqual(currentGraph(done)!.tasks.find(task => task.id === 'deliver')!.dependencies, ['review']);
  assert.equal(done.artifacts.length, 5);
});

test('暂停立即停止派发，当前任务落盘后暂停且恢复不重复成功节点', async t => {
  const executor = new GateExecutor(); const { runtime } = await fixture(t, executor);
  const id = runtime.createRun({ goal: { objective: '暂停' }, initialPlan: { tasks: [makeTask('a'), makeTask('b', ['a'])] } });
  runtime.start(id); await until(runtime, id, state => state.attempts.length === 1);
  runtime.pause(id); assert.equal(runtime.getSnapshot(id).status, 'PAUSING'); executor.finish('a');
  const paused = await until(runtime, id, state => state.status === 'PAUSED'); assert.equal(paused.attempts.length, 1);
  runtime.resume(id); await until(runtime, id, state => state.attempts.length === 2); executor.finish('b');
  await until(runtime, id, state => state.status === 'SUCCEEDED'); assert.equal(executor.calls.filter(call => call.taskId === 'a').length, 1);
});

test('重跑节点使受影响后继失效，无关分支与历史成功记录保留', async t => {
  const { runtime } = await fixture(t, new FakeExecutor(1));
  const id = runtime.createRun({ goal: { objective: '重跑' }, initialPlan: { tasks: [makeTask('a'), makeTask('b', ['a']), makeTask('independent')] } });
  runtime.start(id); const first = await until(runtime, id, state => state.status === 'SUCCEEDED');
  runtime.rerunTask(id, 'a'); const done = await until(runtime, id, state => state.status === 'SUCCEEDED' && state.attempts.length === 5);
  assert.equal(currentTask(done, 'independent')!.generation, 1); assert.equal(currentTask(done, 'b')!.generation, 2);
  for (const old of first.attempts) assert.deepEqual(done.attempts.find(item => item.id === old.id), old);
  assert.equal(done.tasks.filter(task => !task.valid).length, 2);
});

test('命令 ID 幂等且参数冲突被拒绝', async t => {
  const { runtime } = await fixture(t);
  const input = { goal: { objective: '去重' }, initialPlan: { tasks: [makeTask('a')] } };
  const id = runtime.createRun(input, 'create'); assert.equal(runtime.createRun(input, 'create'), id);
  runtime.start(id, 'start'); const seq = runtime.getSnapshot(id).lastEventSeq;
  runtime.start(id, 'start'); assert.equal(runtime.getSnapshot(id).lastEventSeq, seq);
  assert.throws(() => runtime.pause(id, 'start'), /COMMAND_CONFLICT/);
});

test('非法与过期改图完整回滚，不产生版本或事件', async t => {
  const { runtime } = await fixture(t);
  const id = runtime.createRun({ goal: { objective: '图事务' }, initialPlan: { tasks: [makeTask('a'), makeTask('b', ['a'])] } });
  const before = runtime.getSnapshot(id);
  assert.throws(() => runtime.proposePlan(id, { basePlanVersion: 1, baseStateRevision: before.stateRevision, operations: [{ type: 'addDependency', taskId: 'a', dependencyId: 'b' }], reason: '制造环', evidenceRefs: [] }), /环/);
  assert.deepEqual(runtime.getSnapshot(id), before);
  assert.throws(() => runtime.proposePlan(id, { basePlanVersion: 0, baseStateRevision: before.stateRevision, operations: [], reason: '旧图', evidenceRefs: [] }), /STALE_PLAN/);
  assert.deepEqual(runtime.getSnapshot(id), before);
});

test('相同图不创建空版本，修改依赖同时失效新旧后继', async t => {
  const { runtime } = await fixture(t);
  const id = runtime.createRun({ goal: { objective: '图版本' }, initialPlan: { tasks: [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['b'])] } });
  let state = runtime.getSnapshot(id);
  runtime.proposePlan(id, { basePlanVersion: 1, baseStateRevision: state.stateRevision, operations: [], reason: '不变', evidenceRefs: [] });
  state = runtime.getSnapshot(id); assert.equal(state.plans.length, 1);
  runtime.proposePlan(id, { basePlanVersion: 1, baseStateRevision: state.stateRevision, operations: [{ type: 'updateTask', taskId: 'b', changes: { dependencies: [], title: '新任务 B' } }], reason: '变更输入', evidenceRefs: [] });
  state = runtime.getSnapshot(id); assert.equal(currentTask(state, 'a')!.generation, 1); assert.equal(currentTask(state, 'b')!.generation, 2); assert.equal(currentTask(state, 'c')!.generation, 2);
});

test('中断后的恢复创建新 Attempt 并携带检查点', async t => {
  const executor = new FakeExecutor(20); const { runtime } = await fixture(t, executor);
  const id = runtime.createRun({ goal: { objective: '检查点' }, initialPlan: { tasks: [makeTask('a')] } }); runtime.start(id);
  await until(runtime, id, state => state.attempts[0]?.checkpoint !== undefined); runtime.interrupt(id, 'interrupt');
  await until(runtime, id, state => state.status === 'PAUSED'); runtime.interrupt(id, 'interrupt');
  runtime.resume(id); const done = await until(runtime, id, state => state.status === 'SUCCEEDED');
  assert.equal(done.attempts.length, 2); assert.equal(done.attempts[0].status, 'INTERRUPTED'); assert.equal(done.attempts[1].resumedFrom, done.attempts[0].id);
  assert.ok(executor.calls[1].checkpoint);
});

test('崩溃恢复将无法核对的调用标为 UNKNOWN，不自动重发', async t => {
  const executor = new GateExecutor(); const { runtime, filename } = await fixture(t, executor);
  const id = runtime.createRun({ goal: { objective: '未知执行' }, initialPlan: { tasks: [makeTask('a'), makeTask('b', ['a'])] } }); runtime.start(id);
  await until(runtime, id, state => state.attempts.length === 1); await runtime.close({ abandon: true });
  const store = new SqliteStore(filename); const recovered = await createRuntime({ store, planner: new FakePlanner(), executors: { fake: executor } });
  t.after(async () => { await recovered.close({ abandon: true }); store.close(); });
  const state = recovered.getSnapshot(id); assert.equal(state.status, 'WAITING_INPUT'); assert.equal(state.attempts[0].status, 'UNKNOWN'); assert.equal(executor.calls.length, 1);
  assert.throws(() => recovered.resume(id), /核对/); assert.throws(() => recovered.rerunTask(id, 'a'), /核对/);
  assert.throws(() => recovered.restartRun(id), /核对/);
  assert.throws(() => recovered.proposePlan(id, { basePlanVersion: state.planVersion, baseStateRevision: state.stateRevision, reason: '不能绕过未知调用', evidenceRefs: [], operations: [{ type: 'updateTask', taskId: 'a', changes: { title: '替代任务' } }] }), /核对/);
  recovered.resolveAttempt(id, state.attempts[0].id, { status: 'SUCCEEDED', output: { summary: '已核对成功' }, artifactIds: [] }, 'resolve');
  recovered.resolveAttempt(id, state.attempts[0].id, { status: 'SUCCEEDED', output: { summary: '已核对成功' }, artifactIds: [] }, 'resolve');
  recovered.resume(id); await until(recovered, id, value => value.attempts.length === 2); executor.finish('b');
  await until(recovered, id, value => value.status === 'SUCCEEDED');
});

test('外部已完成但尚未落盘的结果通过核对恢复', async t => {
  const executor = new GateExecutor(); const { runtime, filename } = await fixture(t, executor);
  const id = runtime.createRun({ goal: { objective: '结果核对' }, initialPlan: { tasks: [makeTask('a')] } }); runtime.start(id);
  await until(runtime, id, state => state.attempts.length === 1); await runtime.close({ abandon: true });
  const store = new SqliteStore(filename);
  const recovered = await createRuntime({ store, planner: new FakePlanner(), executors: { fake: { execute: executor.execute.bind(executor), async reconcile() { return { status: 'COMPLETED', result: { status: 'SUCCEEDED', output: { summary: '外部已完成' }, artifactIds: [] } }; } } } });
  t.after(async () => { await recovered.close({ abandon: true }); store.close(); });
  const done = await until(recovered, id, state => state.status === 'SUCCEEDED'); assert.equal(done.attempts.length, 1); assert.equal(executor.calls.length, 1);
});

test('暂停状态跨重启保留，已经成功的输出仍可读取', async t => {
  const { runtime, filename } = await fixture(t);
  const id = runtime.createRun({ goal: { objective: '持久暂停' }, initialPlan: { tasks: [makeTask('a')] } }); runtime.pause(id); await runtime.close({ abandon: true });
  const store = new SqliteStore(filename); const executor = new FakeExecutor(); const recovered = await createRuntime({ store, planner: new FakePlanner(), executors: { fake: executor } });
  t.after(async () => { await recovered.close({ abandon: true }); store.close(); });
  assert.equal(recovered.getSnapshot(id).status, 'PAUSED'); assert.equal(executor.calls.length, 0);
});

test('相同写资源互斥', async t => {
  const executor = new GateExecutor(); const { runtime } = await fixture(t, executor);
  const graph = { tasks: [makeTask('a', [], { resources: ['repository:one'] }), makeTask('b', [], { resources: ['repository:one'] })] };
  const id = runtime.createRun({ goal: { objective: '互斥' }, initialPlan: graph }); runtime.start(id);
  await until(runtime, id, state => state.attempts.length === 1); assert.equal(executor.calls.length, 1); executor.finish('a');
  await until(runtime, id, state => state.attempts.length === 2); executor.finish('b'); await until(runtime, id, state => state.status === 'SUCCEEDED');
});

test('数据库只允许一个所有者，过期令牌无法提交状态', async t => {
  const { store, filename } = await fixture(t);
  const other = new SqliteStore(filename); t.after(() => other.close());
  assert.throws(() => other.acquire('other', 1000), /另一个实例/);
  assert.throws(() => store.transact('missing', -1, () => undefined), /LEASE_LOST/);
});

test('未完成验收不会错误标记成功', async t => {
  const planner = new FakePlanner(snapshot => ({ type: 'COMPLETE', reason: '未经执行的错误验收', evidenceRefs: ['nonexistent'] }));
  const { runtime } = await fixture(t, new FakeExecutor(), planner);
  const id = runtime.createRun({ goal: { objective: '错误验收' } }); runtime.start(id);
  const state = await until(runtime, id, value => value.status === 'WAITING_INPUT'); assert.match(state.reason!, /尚未成功/);
});

test('事件严格递增，快照水位支持刷新与断线后补读', async t => {
  const { runtime } = await fixture(t, new FakeExecutor(1));
  const id = runtime.createRun({ goal: { objective: '事件补读' } }); const initial = runtime.getSnapshot(id); runtime.start(id);
  const final = await until(runtime, id, state => state.status === 'SUCCEEDED');
  const events = runtime.listEvents(id, initial.lastEventSeq);
  assert.equal(events.at(-1)!.seq, final.lastEventSeq);
  events.forEach((event, index) => assert.equal(event.seq, initial.lastEventSeq + index + 1));
  assert.equal(runtime.listEvents(id, final.lastEventSeq).length, 0);
  const artifact = final.artifacts[0]; assert.ok(runtime.readArtifact(id, artifact.id).length > 0);
});

test('改图无执行进展达到上限后等待，不无限循环', async t => {
  let calls = 0;
  const planner = new FakePlanner((snapshot, call) => ({ type: 'REVISE', proposal: {
    basePlanVersion: snapshot.planVersion, baseStateRevision: snapshot.stateRevision, reason: '调整未完成的任务', evidenceRefs: [],
    operations: [{ type: 'updateTask', taskId: 'a', changes: { description: `第 ${call} 次调整` } }],
  } }));
  const executor: ExecutorPort = {
    /** 模拟每次均未取得执行进展的工具。 */
    async execute() { calls++; return { status: 'INTERRUPTED', output: {}, artifactIds: [] }; },
    /** 此测试没有跨进程调用。 */
    async reconcile() { return { status: 'UNKNOWN', reason: '无外部状态' }; },
  };
  const { runtime } = await fixture(t, executor, planner);
  const id = runtime.createRun({ goal: { objective: '预算限制' }, initialPlan: { tasks: [makeTask('a')] } });
  runtime.start(id); const state = await until(runtime, id, value => value.status === 'WAITING_INPUT');
  assert.equal(state.noProgressCount, 3); assert.equal(calls, 3); assert.equal(state.plans.length, 4); assert.match(state.reason!, /连续/);
});

test('评估期间暂停使旧决策失效，恢复后使用新快照', async t => {
  let deliver: ((value: import('../src/types.js').PlanDecision) => void) | undefined;
  const planner = new FakePlanner(snapshot => new Promise(resolve => { deliver = resolve; }));
  const { runtime } = await fixture(t, new FakeExecutor(), planner);
  const id = runtime.createRun({ goal: { objective: '暂停规划' } }); runtime.start(id);
  await until(runtime, id, state => state.status === 'PLANNING'); runtime.pause(id);
  deliver!({ type: 'WAIT', reason: '过期决策' });
  const paused = await until(runtime, id, state => state.status === 'PAUSED'); assert.equal(paused.needsEvaluation, true);
  assert.ok(runtime.listEvents(id).some(event => event.type === 'evaluation.discarded'));
});

test('未声明隔离能力的执行器跨独立任务串行', async t => {
  const gate = new GateExecutor(); const executor: ExecutorPort = { execute: gate.execute.bind(gate), reconcile: gate.reconcile.bind(gate) };
  const { runtime } = await fixture(t, executor);
  const id = runtime.createRun({ goal: { objective: '保守调度' }, initialPlan: { tasks: [makeTask('a'), makeTask('b')] } }); runtime.start(id);
  await until(runtime, id, state => state.attempts.length === 1); assert.equal(gate.calls.length, 1); gate.finish('a');
  await until(runtime, id, state => state.attempts.length === 2); gate.finish('b'); await until(runtime, id, state => state.status === 'SUCCEEDED');
});

test('过期租约被接管后，旧实例的迟到回调不能回写', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'goalsplit-fence-')); const filename = join(directory, 'db.sqlite');
  const store = new SqliteStore(filename); const gate = new GateExecutor();
  const old = await createRuntime({ store, planner: new FakePlanner(), executors: { fake: gate }, leaseMs: 80 });
  const id = old.createRun({ goal: { objective: '隔离旧实例' }, initialPlan: { tasks: [makeTask('a')] } }); old.start(id);
  await until(old, id, state => state.attempts.length === 1);
  // 阻塞当前事件循环模拟旧进程冻结，阻止它及时续租。
  const deadline = Date.now() + 110; while (Date.now() < deadline) { /* 等待租约过期。 */ }
  const takeover = new SqliteStore(filename); const token = takeover.acquire('new-owner', 5000);
  const before = takeover.read(id); gate.finish('a'); await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(takeover.read(id), before); assert.throws(() => old.pause(id), /关闭|租约/);
  takeover.release('new-owner', token); takeover.close(); await old.close({ abandon: true }); store.close();
});

test('暂停期间补充输入持久化，并仅影响后续冻结上下文', async t => {
  const gate = new GateExecutor(); const { runtime } = await fixture(t, gate);
  const id = runtime.createRun({ goal: { objective: '补充需求' }, initialPlan: { tasks: [makeTask('a'), makeTask('b', ['a'])] } }); runtime.start(id);
  await until(runtime, id, state => state.attempts.length === 1); runtime.pause(id); runtime.addInput(id, '输出应包含验收说明', 'input'); runtime.addInput(id, '输出应包含验收说明', 'input');
  gate.finish('a'); await until(runtime, id, state => state.status === 'PAUSED');
  assert.equal(runtime.getSnapshot(id).userInputs.length, 1); assert.equal(gate.calls[0].input.userInputs.length, 0);
  runtime.resume(id); await until(runtime, id, state => state.attempts.length === 2); assert.equal(gate.calls[1].input.userInputs[0].text, '输出应包含验收说明');
  gate.finish('b'); await until(runtime, id, state => state.status === 'SUCCEEDED');
});

test('排空期间崩溃不会丢失已持久化的重跑请求', async t => {
  const gate = new GateExecutor(); const { runtime, filename } = await fixture(t, gate);
  const id = runtime.createRun({ goal: { objective: '恢复待重跑请求' }, initialPlan: { tasks: [makeTask('a'), makeTask('b', ['a'])] } }); runtime.start(id);
  await until(runtime, id, state => state.attempts.length === 1); runtime.rerunTask(id, 'a'); await runtime.close({ abandon: true });
  const store = new SqliteStore(filename); const fake = new FakeExecutor(1);
  const recovered = await createRuntime({ store, planner: new FakePlanner(), executors: { fake: {
    capabilities: fake.capabilities, execute: fake.execute.bind(fake),
    /** 外部系统证明崩溃前的任务已完成，可安全应用待重跑请求。 */
    async reconcile() { return { status: 'COMPLETED', result: { status: 'SUCCEEDED', output: { summary: '原任务已完成' }, artifactIds: [] } }; },
  } } });
  t.after(async () => { await recovered.close({ abandon: true }); store.close(); });
  const done = await until(recovered, id, state => state.status === 'SUCCEEDED');
  assert.equal(currentTask(done, 'a')!.generation, 2); assert.equal(done.attempts.length, 3); assert.equal(done.pendingReruns.length, 0);
});
