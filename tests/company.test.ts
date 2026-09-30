import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from 'cordis';
import { agentsRuntimePlugin, type RuntimeProcessExecutor } from '../agents-runtime/index.js';
import { companyPlugin, companyServerPlugin, type CompanyOptions, type CompanySnapshot } from '../company/index.js';
import { companyClientPlugin } from '../company/client.js';
import { dagPlugin } from '../cordis/dag.js';
import { pixelStudioPlugin } from '../pixel-studio/index.js';
const graph = {
  nodes: ['first', 'second', 'independent'].map(id => ({ id, data: { agentId: 'worker', instruction: id, input: { task: id } } })),
  edges: [{ id: 'dependency', source: 'first', target: 'second', data: { requires: 'answer' } }],
};
function mock(answer: (input: string) => unknown | Promise<unknown>): RuntimeProcessExecutor {
  return (_command, _args, options) => {
    let stopped = false;
    return { stop() { stopped = true; }, done: Promise.resolve().then(async () => {
      const result = await answer(options.input ?? '');
      if (!stopped) options.onLine?.('stdout', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: typeof result === 'string' ? result : JSON.stringify(result) } }));
      return { code: stopped ? 1 : 0, error: stopped ? 'stopped' : '' };
    }) };
  };
}
async function host(execute: RuntimeProcessExecutor, config: Partial<CompanyOptions> = {}, server = false) {
  const root = await mkdtemp(join(tmpdir(), 'company-test-'));
  const ctx = new Context();
  ctx.plugin(agentsRuntimePlugin, { dataDir: join(root, 'runtime'), agents: { planner: { hostType: 'codex', cwd: tmpdir() }, worker: { hostType: 'codex', cwd: tmpdir() } }, execute });
  const fork = ctx.plugin(companyPlugin, { rootDir: join(root, 'context'), plannerAgentId: 'planner', workerAgentIds: ['worker'], ...config });
  if (server) { await writeFile(join(root, 'index.html'), '<html>company</html>'); ctx.plugin(companyServerPlugin, { port: 0, staticDir: root }); }
  await ctx.start();
  if (server) await ctx.companyServer.ready;
  return { ctx, root, fork, async close() { await ctx.stop(); await rm(root, { force: true, recursive: true }); } };
}
const success = { status: 'SUCCEEDED', summary: '交付完成', output: { answer: 42 } };
const parse = (input: string) => JSON.parse(input.slice(input.lastIndexOf('\n') + 1));
const planning = (input: string) => input.startsWith('你是公司任务规划负责人');
async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) { if (Date.now() > end) throw new Error('等待状态超时'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('公司服务规划并执行 DAG，传递上游产物，发布运行状态并保存 context', async () => {
  const requests: unknown[] = [];
  const app = await host(mock(input => {
    if (planning(input)) { assert.deepEqual(parse(input).goal.context, { constraint: 'keep' }); return graph; }
    const request = parse(input); requests.push(request);
    if (request.nodeId === 'second') assert.deepEqual(request.dependencies[0].output, success.output);
    return success;
  }));
  try {
    const revisions: CompanySnapshot[] = [];
    app.ctx.company.subscribe(() => { revisions.push(app.ctx.company.list()[0]); });
    const original = app.ctx.company.submit({ objective: '完成任务', context: { constraint: 'keep' } });
    assert.equal(original.status, 'PLANNING');
    assert.throws(() => app.ctx.company.submit({ objective: '另一个目标' }), /正在执行/);
    const result = await app.ctx.company.wait(original.runId);
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(requests.length, 3);
    assert.equal(Object.keys(result.feedback).length, 3);
    assert.ok(revisions.some(snapshot => snapshot.studio.actors.some(actor => actor.status === 'working') && snapshot.run?.states.first.status === 'RUNNING'));
    assert.ok(revisions.every((snapshot, index) => index === 0 || snapshot.revision > revisions[index - 1].revision));
    assert.ok(Object.isFrozen(result.run!.states));
    assert.deepEqual((await app.ctx.agentsDag.runtime.getNodeContext(original.runId, 'second')).output, success.output);
  } finally { await app.close(); }
});

test('规划拒绝环、空图、错误 JSON、超限和未知 Agent，不启动执行节点', async () => {
  for (const bad of [
    'not-json', { nodes: [], edges: [] },
    { ...graph, edges: [...graph.edges, { id: 'reverse', source: 'second', target: 'first', data: {} }] },
    { nodes: [{ id: 'unknown', data: { agentId: 'other', instruction: '任务', input: {} } }], edges: [] },
    graph,
  ]) {
    let nodes = 0;
    const app = await host(mock(input => { if (!planning(input)) nodes++; return bad; }), { maxNodes: 2 });
    try {
      const result = await app.ctx.company.wait(app.ctx.company.submit({ objective: '目标' }).runId);
      assert.equal(result.status, 'FAILED'); assert.equal(nodes, 0); assert.ok(result.error); assert.equal(result.studio.actors[0].status, 'error');
    } finally { await app.close(); }
  }
});

test('节点失败不放行下游，但独立节点继续执行，产物与错误可见', async () => {
  const executed: string[] = [];
  const app = await host(mock(input => {
    if (planning(input)) return graph;
    const { nodeId } = parse(input); executed.push(nodeId);
    return nodeId === 'first' ? { status: 'FAILED', summary: '无法完成', output: {}, error: '缺少信息' } : success;
  }));
  try {
    const result = await app.ctx.company.wait(app.ctx.company.submit({ objective: '目标' }).runId);
    assert.equal(result.status, 'FAILED');
    assert.deepEqual(executed.sort(), ['first', 'independent']);
    assert.equal(result.run!.states.second.status, 'BLOCKED');
    assert.equal(result.feedback.first.status, 'FAILED');
    assert.equal(result.run!.states.independent.status, 'SUCCEEDED');
  } finally { await app.close(); }
});

test('规划取消与插件卸载停止活动 CLI，等待进程退出，不启动下游', async () => {
  let started = 0; let stopped = 0;
  const app = await host(() => {
    started++;
    let finish!: (value: { code: number; error: string }) => void;
    return { done: new Promise(resolve => { finish = resolve; }), stop() { stopped++; finish({ code: 1, error: 'stopped' }); } };
  });
  try {
    const id = app.ctx.company.submit({ objective: '目标' }).runId;
    await until(() => started === 1);
    assert.equal(app.ctx.company.cancel(id).status, 'CANCELLED');
    assert.equal((await app.ctx.company.wait(id)).status, 'CANCELLED');
    assert.equal(stopped, 1);
    const company = app.ctx.company;
    const other = company.submit({ objective: '第二个目标' }).runId;
    await until(() => started === 2);
    await app.fork.dispose();
    assert.equal((await company.wait(other)).status, 'CANCELLED');
    assert.equal(stopped, 2);
    assert.throws(() => company.submit({ objective: '第三个目标' }), /关闭/);
  } finally { await app.close(); }
});

test('执行节点取消后保存失败反馈，并且不再启动下游', async () => {
  let stopped = 0; let workerStarted = false;
  const app = await host((command, args, options) => {
    if (planning(options.input ?? '')) return mock(() => graph)(command, args, options);
    workerStarted = true;
    let finish!: (value: { code: number; error: string }) => void;
    return { done: new Promise(resolve => { finish = resolve; }), stop() { stopped++; finish({ code: 1, error: 'stopped' }); } };
  });
  try {
    const id = app.ctx.company.submit({ objective: '目标' }).runId;
    await until(() => workerStarted);
    app.ctx.company.cancel(id);
    const result = await app.ctx.company.wait(id);
    assert.equal(stopped, 1); assert.equal(result.status, 'CANCELLED');
    assert.equal(result.run!.states.first.status, 'FAILED'); assert.equal(result.run!.states.second.attempt, 0);
    assert.equal(result.feedback.first.status, 'FAILED');
  } finally { await app.close(); }
});

test('本机 API 与浏览器 Cordis 服务同步 DAG/办公室；阻止跨站任务并清理轮询', async () => {
  const app = await host(mock(input => planning(input) ? graph : success), {}, true);
  const browser = new Context();
  browser.plugin(dagPlugin); browser.plugin(pixelStudioPlugin);
  browser.plugin(companyClientPlugin, { baseURL: app.ctx.companyServer.url + '/api/company', pollMs: 15 });
  try {
    const base = app.ctx.companyServer.url;
    assert.equal((await fetch(base)).status, 200);
    const denied = await fetch(base + '/api/company/tasks', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://malicious.example' }, body: JSON.stringify({ objective: '不能执行' }) });
    assert.equal(denied.status, 403); assert.equal(app.ctx.company.list().length, 0);
    assert.equal((await fetch(base + '/api/company/tasks/missing')).status, 404);
    assert.equal((await fetch(base + '/api/company/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
    await browser.start();
    await until(() => browser.companyClient.getSnapshot().connected);
    await browser.companyClient.submit('通过页面提交目标');
    await until(() => browser.companyClient.getSnapshot().current?.status === 'SUCCEEDED');
    assert.equal(browser.dagGraph.getSnapshot().nodes.length, 3);
    assert.equal(browser.dagGraph.getSnapshot().nodes[0].data.status, 'SUCCEEDED');
    assert.equal(browser.pixelStudio.getSnapshot().snapshot!.tasks.length, 3);
    assert.equal(browser.pixelStudio.getSnapshot().snapshot!.actors[0].status, 'success');
    await browser.stop();
    assert.equal(browser.pixelStudio, undefined);
  } finally { await browser.stop(); await app.close(); }
});
