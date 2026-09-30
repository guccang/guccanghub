import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from 'cordis';
import { createDag } from '../dag/index.js';
import { agentsRuntimePlugin, runtimeAgentsDagPlugin, type RuntimeProcessExecutor, type RuntimeEvent } from '../agents-runtime/index.js';
import type { AgentExecutionInput } from '../agents-dag-context/types.js';
const feedback = { status: 'SUCCEEDED', summary: '完成任务', output: { answer: 42 } };
const request: AgentExecutionInput = { runId: 'run', nodeId: 'node', attempt: 1, agentId: 'worker', instruction: '任务', goal: { objective: '目标', context: {} }, input: {}, dependencies: [] };

function mockCodex(finalMessage = JSON.stringify(feedback), code = 0): RuntimeProcessExecutor {
  return (_command, _args, options) => ({
    stop() {},
    done: Promise.resolve().then(() => {
      options.onLine?.('stdout', JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }));
      options.onLine?.('stdout', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: finalMessage } }));
      options.onLine?.('stdout', JSON.stringify({ type: 'turn.completed' }));
      return { code, error: '' };
    }),
  });
}
function install(ctx: Context, execute: RuntimeProcessExecutor) {
  return ctx.plugin(agentsRuntimePlugin, { dataDir: join(tmpdir(), 'guccanghub-runtime-test'), agents: { worker: { hostType: 'codex', cwd: tmpdir(), model: 'configured-model' } }, execute });
}

test('实际上游 Codex 解析器透传工作目录、会话和原生事件', async () => {
  const ctx = new Context();
  const events: RuntimeEvent[] = [];
  const sessions: string[] = [];
  ctx.on('agents-runtime/event', event => { events.push(event); });
  ctx.on('agents-runtime/session', event => { sessions.push(event.sessionId); });
  install(ctx, (command, args, options) => {
    assert.equal(command, 'codex');
    assert.equal(options.cwd, tmpdir());
    if (options.input === '完成任务') {
      assert.ok(args.includes('resume'));
      assert.ok(args.includes('existing-session'));
    } else assert.ok(options.input?.includes('"nodeId":"node"'));
    assert.ok(args.includes('configured-model'));
    return mockCodex()(command, args, options);
  });
  await ctx.start();
  try {
    const result = await ctx.agentsRuntime.run({ id: 'task', agentId: 'worker', input: '完成任务', sessionId: 'existing-session' });
    assert.equal(result.code, 0);
    assert.equal(result.sessionId, 'session-1');
    assert.equal(result.error, '');
    assert.equal(events[0].taskId, 'task');
    assert.deepEqual(sessions, ['session-1']);
    assert.deepEqual(ctx.agentsRuntime.activeTaskIds, []);
    assert.deepEqual(await ctx.agentsRuntime.execute(request), feedback);
  } finally { await ctx.stop(); }
});

test('进程失败、非 JSON 和业务失败不会被零退出码掩盖', async () => {
  for (const [text, code, errorPattern] of [
    ['not-json', 0, /JSON|Unexpected/],
    [JSON.stringify(feedback), 1, /退出码/],
    [JSON.stringify({ status: 'SUCCEEDED', summary: '完成', output: {}, extra: true }), 0, /协议外/],
  ] as const) {
    const ctx = new Context();
    install(ctx, mockCodex(text, code));
    await ctx.start();
    try {
      const result = await ctx.agentsRuntime.execute(request);
      assert.equal(result.status, 'FAILED');
      if (result.status === 'FAILED') assert.match(result.error, errorPattern);
    } finally { await ctx.stop(); }
  }
  const ctx = new Context();
  const businessFailure = { status: 'FAILED', summary: '任务无法完成', output: {}, error: '缺少输入' };
  install(ctx, mockCodex(JSON.stringify(businessFailure)));
  await ctx.start();
  try { assert.deepEqual(await ctx.agentsRuntime.execute(request), businessFailure); }
  finally { await ctx.stop(); }
});

test('重复任务、取消、超时和卸载均停止进程并释放句柄', async () => {
  const ctx = new Context();
  let stopped = 0;
  const fork = install(ctx, () => {
    let finish!: (value: { code: number; error: string }) => void;
    const done = new Promise<{ code: number; error: string }>(resolve => { finish = resolve; });
    return { done, stop() { stopped++; finish({ code: 0, error: '' }); } };
  });
  await ctx.start();
  const runtime = ctx.agentsRuntime;
  const task = { id: 'task', agentId: 'worker', input: '任务' };
  try {
    const abort = new AbortController();
    const first = runtime.startTask(task, { signal: abort.signal });
    assert.throws(() => runtime.startTask(task), /正在执行/);
    abort.abort();
    assert.match((await first.done).error, /取消/);
    assert.deepEqual(runtime.activeTaskIds, []);
    const timed = await runtime.run(task, { timeoutMs: 5 });
    assert.equal(timed.stopped, true);
    assert.match(timed.error, /超时/);
    const pending = runtime.startTask(task);
    await fork.dispose();
    assert.equal((await pending.done).stopped, true);
    assert.equal(stopped, 3);
    assert.throws(() => runtime.startTask(task), /关闭/);
    assert.equal(ctx.agentsRuntime, undefined);
  } finally { await ctx.stop(); }
});

test('runtime 自动注入 DAG 执行器，并将上游输出写入节点 context', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'runtime-dag-'));
  const ctx = new Context();
  try {
    install(ctx, (command, args, options) => {
      if (options.input?.includes('"nodeId":"second"')) assert.ok(options.input.includes('"answer":42'));
      return mockCodex()(command, args, options);
    });
    ctx.plugin(runtimeAgentsDagPlugin, {
      rootDir,
      planner: { async decompose() {
        return createDag({
          nodes: ['first', 'second'].map(id => ({ id, data: { agentId: 'worker', instruction: id, input: {} } })),
          edges: [{ id: 'link', source: 'first', target: 'second', data: {} }],
        });
      } },
    });
    await ctx.start();
    await ctx.agentsDag.runtime.decomposeGoal('run', { objective: '完成任务', context: {} });
    const result = await ctx.agentsDag.runtime.executeDag('run');
    assert.equal(result.states.second.status, 'SUCCEEDED');
    assert.deepEqual((await ctx.agentsDag.runtime.getNodeContext('run', 'second')).output, feedback.output);
  } finally { await ctx.stop(); await rm(rootDir, { recursive: true, force: true }); }
});

test('缺少配置或已经取消的任务不启动 CLI', async () => {
  const ctx = new Context();
  let started = 0;
  install(ctx, (command, args, options) => { started++; return mockCodex()(command, args, options); });
  await ctx.start();
  try {
    assert.throws(() => ctx.agentsRuntime.startTask({ id: 'task', agentId: 'missing', input: '任务' }), /未配置/);
    const abort = new AbortController(); abort.abort();
    assert.throws(() => ctx.agentsRuntime.startTask({ id: 'task', agentId: 'worker', input: '任务' }, { signal: abort.signal }), /取消/);
    assert.equal(started, 0);
  } finally { await ctx.stop(); }
});

test('Claude、OpenCode 和 DeepSeek ACP 通过上游驱动完成结构化任务', async () => {
  for (const hostType of ['claudecode', 'opencode', 'deepseek-harness'] as const) {
    const ctx = new Context();
    const execute: RuntimeProcessExecutor = (command, _args, options) => {
      const emit = (event: unknown) => options.onLine?.('stdout', JSON.stringify(event));
      if (command === 'dsh') {
        let finish!: (result: { code: number; error: string }) => void;
        const done = new Promise<{ code: number; error: string }>(resolve => { finish = resolve; });
        return {
          done, stop() { finish({ code: 1, error: 'stopped' }); }, endInput() { finish({ code: 0, error: '' }); },
          write(value) {
            const frame = JSON.parse(value);
            queueMicrotask(() => {
              if (frame.method === 'session/prompt') emit({ method: 'session/update', params: { sessionId: 'acp-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(feedback) } } } });
              emit({ id: frame.id, result: frame.method === 'session/new' ? { sessionId: 'acp-session' } : frame.method === 'session/prompt' ? { stopReason: 'end_turn' } : {} });
            });
          },
        };
      }
      return { stop() {}, done: Promise.resolve().then(() => {
        if (command === 'claude') emit({ type: 'result', subtype: 'success', session_id: 'claude-session', result: JSON.stringify(feedback) });
        else {
          assert.equal(command, 'opencode');
          emit({ type: 'text', sessionID: 'opencode-session', part: { messageID: 'message', text: JSON.stringify(feedback) } });
          emit({ type: 'step_finish', part: { reason: 'stop' } });
        }
        return { code: 0, error: '' };
      }) };
    };
    ctx.plugin(agentsRuntimePlugin, { dataDir: join(tmpdir(), 'runtime-multi-host-test'), agents: { worker: { hostType, cwd: tmpdir() } }, execute });
    await ctx.start();
    try { assert.deepEqual(await ctx.agentsRuntime.execute(request), feedback); }
    finally { await ctx.stop(); }
  }
});
