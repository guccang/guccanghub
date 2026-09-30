/** 崩溃注入子进程：在真实事务或外部副作用边界硬退出。 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '../src/runtime.js';
import { SqliteStore } from '../src/sqlite.js';
import { FakePlanner, makeTask } from '../src/testing.js';
import type { ExecutionResult, StoreTransaction } from '../src/types.js';
const [directory, scenario] = process.argv.slice(2);
/** 在指定事务提交后立即退出，模拟未执行清理的进程终止。 */
class CrashStore extends SqliteStore {
  /** 在派发意图或成功结果落盘后注入崩溃。 */
  override transact<T>(runId: string, fence: number, action: (tx: StoreTransaction) => T, command?: { id: string; fingerprint: string }): T {
    const result = super.transact(runId, fence, action, command);
    const attempt = this.read(runId).attempts.at(-1);
    if (scenario === 'after_dispatch' && attempt?.status === 'DISPATCHED') process.exit(23);
    if (scenario === 'after_commit' && attempt?.status === 'SUCCEEDED') process.exit(25);
    return result;
  }
}
const store = new CrashStore(join(directory, 'db.sqlite'));
const result: ExecutionResult = { status: 'SUCCEEDED', output: { summary: '外部任务已完成' }, artifactIds: [] };
const runtime = await createRuntime({ store, planner: new FakePlanner(), leaseMs: 100, executors: { fake: {
  /** 保存一次副作用，再模拟结果尚未提交时崩溃。 */
  async execute() { writeFileSync(join(directory, 'external-result.json'), JSON.stringify(result)); if (scenario === 'before_commit') process.exit(24); return result; },
  /** 子进程仅负责注入，不执行恢复。 */
  async reconcile() { return { status: 'UNKNOWN', reason: '不应在子进程恢复' }; },
} } });
const id = runtime.createRun({ goal: { objective: scenario }, initialPlan: { tasks: [makeTask('task')] } });
writeFileSync(join(directory, 'run.txt'), id); runtime.start(id);
