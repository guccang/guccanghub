/** 通过公开 Cordis 服务运行 Agent；默认模拟 CLI，--live 使用真实宿主。 */
import { Context } from 'cordis';
import { resolve } from 'node:path';
import { createDag } from '@goalsplit/dag';
import { agentsRuntimePlugin, runtimeAgentsDagPlugin, type RuntimeProcessExecutor } from '@goalsplit/dag/agents-runtime';
import { runtimeConfigFromEnv } from '@goalsplit/dag/cordis/config.node';
import { serviceDefaults } from '@goalsplit/dag/cordis/config';
import { pixelStudioPlugin, agentRunToStudio } from '@goalsplit/dag/pixel-studio';

const live = process.argv.includes('--live');
// 经过上游真正的事件解析器，但不启动 CLI 或访问模型。
const simulate: RuntimeProcessExecutor = (_command, _args, options) => ({
  stop() {},
  done: Promise.resolve().then(() => {
    options.onLine?.('stdout', JSON.stringify({ type: 'thread.started', thread_id: 'demo-session' }));
    options.onLine?.('stdout', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'SUCCEEDED', summary: '模拟 Agent 完成任务', output: { message: '可替换为真实 CLI 执行结果' } }) } }));
    options.onLine?.('stdout', JSON.stringify({ type: 'turn.completed' }));
    return { code: 0, error: '' };
  }),
});
const ctx = new Context();
ctx.plugin(agentsRuntimePlugin, {
  ...runtimeConfigFromEnv(['worker'], { demo: !live }),
  ...(!live ? { execute: simulate } : {}),
});
ctx.plugin(pixelStudioPlugin);
ctx.plugin(runtimeAgentsDagPlugin, {
  rootDir: resolve(serviceDefaults.agentsDag.rootDir),
  planner: { async decompose({ goal }) {
    return createDag({ nodes: [{ id: 'task', data: { agentId: 'worker', instruction: goal.objective, input: {} } }], edges: [] });
  } },
});
const runId = `runtime-${Date.now()}-${process.pid}`;
await ctx.start();
try {
  await ctx.agentsDag.runtime.decomposeGoal(runId, { objective: process.env.AGENT_TASK ?? '检查当前项目结构，返回简短说明。', context: {} });
  const result = await ctx.agentsDag.runtime.executeDag(runId);
  ctx.pixelStudio.publish(agentRunToStudio(result, { revision: 1 }));
  console.log(JSON.stringify({ mode: live ? 'live' : 'simulated', runId, node: await ctx.agentsDag.runtime.getNodeContext(runId, 'task'), studio: ctx.pixelStudio.getSnapshot() }, null, 2));
  if (result.states.task.status !== 'SUCCEEDED') process.exitCode = 1;
} finally { await ctx.stop(); }
