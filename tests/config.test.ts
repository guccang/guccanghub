import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from 'cordis';
import { serviceDefaults } from '../cordis/config.js';
import { companyConfigFromEnv, runtimeConfigFromEnv, llmConfigFromEnv, serverConfigFromEnv } from '../cordis/config.node.js';
import { companyAppPlugin } from '../cordis/app.js';
import type { RuntimeProcessExecutor } from '../agents-runtime/index.js';

test('统一默认值与环境配置隔离，模拟宿主不受真实 CLI 设置影响', () => {
  assert.ok(Object.isFrozen(serviceDefaults));
  assert.ok(Object.isFrozen(serviceDefaults.company.workerAgentIds));
  const env = { AGENT_HOST: 'claudecode', AGENT_CWD: tmpdir(), AGENT_MODEL: 'model', AGENT_TIMEOUT_MS: '0', AGENT_REASONING_EFFORT: 'high', COMPANY_PORT: '4320' };
  const config = companyConfigFromEnv({ env });
  assert.equal(config.agentsRuntime.timeoutMs, 0);
  assert.equal(config.agentsRuntime.agents.planner.hostType, 'claudecode');
  assert.equal(config.agentsRuntime.agents.builder.model, 'model');
  assert.equal(config.agentsRuntime.agents.builder.reasoningEffort, 'high');
  assert.equal(config.companyServer!.port, 4320);
  assert.deepEqual(config.company.workerAgentIds, ['researcher', 'builder', 'reviewer']);
  assert.equal(runtimeConfigFromEnv(['worker'], { env, demo: true }).agents.worker.hostType, 'codex');
  const copy = runtimeConfigFromEnv(['one', 'two'], { env });
  assert.notEqual(copy.agents.one, copy.agents.two);
  assert.notEqual(copy.env, env);
  assert.equal(serviceDefaults.companyServer.port, 4318);
});

test('环境加载器拒绝无效端口、超时、宿主或不完整 LLM 配置', () => {
  for (const port of ['', '-1', '65536', '1.5', 'NaN', ' 4318 ']) assert.throws(() => serverConfigFromEnv({ COMPANY_PORT: port }), /COMPANY_PORT/);
  assert.equal(serverConfigFromEnv({ COMPANY_PORT: '0' }).port, 0);
  assert.throws(() => runtimeConfigFromEnv(['worker'], { env: { AGENT_HOST: 'unknown' } }), /AGENT_HOST/);
  assert.throws(() => runtimeConfigFromEnv(['worker'], { env: { AGENT_TIMEOUT_MS: '-1' } }), /AGENT_TIMEOUT_MS/);
  assert.throws(() => llmConfigFromEnv({}), /LLM_API_KEY/);
  const env = { LLM_API_KEY: 'secret-one', LLM_MODEL: 'model', LLM_BASE_URL: 'https://example.test/v1', LLM_TIMEOUT_MS: '1000' };
  const config = llmConfigFromEnv(env);
  assert.equal(config.timeoutMs, 1000);
  assert.equal(typeof config.provider.apiKey, 'function');
  env.LLM_API_KEY = 'secret-two';
  assert.equal((config.provider.apiKey as () => string)(), 'secret-two');
  assert.ok(!JSON.stringify(config).includes('secret-'));
});

function successfulProcess(): RuntimeProcessExecutor {
  return (_command, _args, options) => ({ stop() {}, done: Promise.resolve().then(() => {
    const planning = options.input!.startsWith('你是公司任务规划负责人');
    const result = planning ? { nodes: [{ id: 'deliver', data: { agentId: 'builder', instruction: '交付结果', input: {} } }], edges: [] } : { status: 'SUCCEEDED', summary: '完成', output: { answer: 42 } };
    options.onLine?.('stdout', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } }));
    return { code: 0, error: '' };
  }) });
}

test('统一 Node.js 插件装配 runtime、company、HTTP 和 LLM，卸载整组服务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cordis-app-'));
  const ctx = new Context();
  const config = companyConfigFromEnv({ demo: true, env: { AGENT_CWD: tmpdir(), COMPANY_PORT: '0' } });
  const fork = ctx.plugin(companyAppPlugin, {
    ...config,
    agentsRuntime: { ...config.agentsRuntime, dataDir: join(root, 'runtime'), execute: successfulProcess() },
    company: { ...config.company, rootDir: join(root, 'context') },
    llm: { providers: [{ id: 'api', baseURL: 'https://example.test/v1', apiKey: 'test-key', fetch: async () => Response.json({ choices: [{ message: { content: 'API 连通' }, finish_reason: 'stop' }] }) }, { id: 'second', baseURL: 'https://second.example.test/v1', apiKey: 'test-key', fetch: async () => Response.json({ choices: [{ message: { content: '第二个提供方' }, finish_reason: 'stop' }] }) }] },
  });
  try {
    await ctx.start(); await ctx.companyServer.ready;
    const task = ctx.company.submit({ objective: '完成目标' });
    assert.equal((await ctx.company.wait(task.runId)).status, 'SUCCEEDED');
    const response = await fetch(ctx.companyServer.url + serviceDefaults.companyClient.baseURL + '/tasks');
    assert.equal(response.status, 200);
    assert.equal((await response.json())[0].runId, task.runId);
    assert.equal((await ctx.llm.generate({ provider: 'api', model: 'mock', messages: [{ role: 'user', content: '测试' }] })).text, 'API 连通');
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id).sort(), ['api', 'second']);
    assert.equal((await ctx.llm.generate({ provider: 'second', model: 'mock', messages: [{ role: 'user', content: '测试' }] })).text, '第二个提供方');
    await fork.dispose();
    for (const service of ['agentsRuntime', 'agentsDag', 'company', 'companyServer', 'llm']) assert.equal(ctx.get(service), undefined);
  } finally { await ctx.stop(); await rm(root, { recursive: true, force: true }); }
});

test('卸载统一装配插件取消规划并等待子进程退出', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cordis-app-stop-'));
  const ctx = new Context();
  let stopped = 0;
  const execute: RuntimeProcessExecutor = () => {
    let finish!: (value: { code: number; error: string }) => void;
    return { done: new Promise(resolve => { finish = resolve; }), stop() { stopped++; finish({ code: 1, error: 'stopped' }); } };
  };
  const config = companyConfigFromEnv({ demo: true, env: { AGENT_CWD: tmpdir() } });
  const fork = ctx.plugin(companyAppPlugin, { agentsRuntime: { ...config.agentsRuntime, dataDir: join(root, 'runtime'), execute }, company: { ...config.company, rootDir: join(root, 'context') } });
  try {
    await ctx.start();
    const company = ctx.company;
    const task = company.submit({ objective: '长时间运行任务' });
    const deadline = Date.now() + 3000;
    while (!ctx.agentsRuntime.activeTaskIds.length) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
    await fork.dispose();
    assert.equal((await company.wait(task.runId)).status, 'CANCELLED');
    assert.equal(stopped, 1);
  } finally { await ctx.stop(); await rm(root, { recursive: true, force: true }); }
});
