/** 使用真实进程硬退出验证 WAL、派发意图与外部结果核对。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../src/runtime.js';
import { SqliteStore } from '../src/sqlite.js';
import { FakePlanner } from '../src/testing.js';

for (const scenario of ['after_dispatch', 'before_commit', 'after_commit']) {
  test(`硬崩溃恢复：${scenario}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'goalsplit-crash-'));
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/crash-worker.ts', directory, scenario], { encoding: 'utf8', timeout: 10000 });
    assert.ok([23, 24, 25].includes(child.status!), `${child.stdout}\n${child.stderr}`);
    await new Promise(resolve => setTimeout(resolve, 120));
    const id = readFileSync(join(directory, 'run.txt'), 'utf8'); const store = new SqliteStore(join(directory, 'db.sqlite')); let executions = 0;
    const runtime = await createRuntime({ store, planner: new FakePlanner(), executors: { fake: {
      /** 任何重新执行都计数，测试应保持零次。 */
      async execute() { executions++; return { status: 'FAILED', output: {}, artifactIds: [] }; },
      /** 通过模拟外部系统的持久化结果核对，而非重新执行。 */
      async reconcile() { return existsSync(join(directory, 'external-result.json')) ? { status: 'COMPLETED', result: JSON.parse(readFileSync(join(directory, 'external-result.json'), 'utf8')) } : { status: 'UNKNOWN', reason: '没有外部核对证据' }; },
    } } });
    t.after(async () => { await runtime.close({ abandon: true }); store.close(); });
    for (let i = 0; i < 100 && !['SUCCEEDED', 'WAITING_INPUT'].includes(runtime.getSnapshot(id).status); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const state = runtime.getSnapshot(id); assert.equal(executions, 0); assert.equal(state.attempts.length, 1);
    assert.equal(state.status, scenario === 'after_dispatch' ? 'WAITING_INPUT' : 'SUCCEEDED');
    assert.equal(state.attempts[0].status, scenario === 'after_dispatch' ? 'UNKNOWN' : 'SUCCEEDED');
    const events = runtime.listEvents(id); events.forEach((event, index) => assert.equal(event.seq, index + 1));
  });
}
