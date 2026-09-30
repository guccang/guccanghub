/** 公司宿主：默认真实 CLI；--demo 仅用于验证流程与可视化。 */
import { Context } from 'cordis';
import { type RuntimeProcessExecutor } from '@goalsplit/dag/agents-runtime';
import { companyAppPlugin } from '@goalsplit/dag/cordis/app';
import { companyConfigFromEnv } from '@goalsplit/dag/cordis/config.node';
const demo = process.argv.includes('--demo');
/** 模拟走真正的上游 Codex 协议解析；延时让 UI 能展示每次状态变化。 */
const simulate: RuntimeProcessExecutor = (_command, _args, options) => {
  let finish!: (value: { code: number; error: string }) => void;
  const done = new Promise<{ code: number; error: string }>(resolveDone => { finish = resolveDone; });
  const timer = setTimeout(() => {
    const text = options.input ?? '';
    const planning = text.startsWith('你是公司任务规划负责人');
    const request = JSON.parse(text.slice(text.lastIndexOf('\n') + 1));
    const result = planning ? {
      nodes: [
        { id: 'research', data: { agentId: 'researcher', instruction: '分析目标，明确范围与验收条件', input: {} } },
        { id: 'produce', data: { agentId: 'builder', instruction: '根据分析结果完成任务产物', input: {} } },
        { id: 'review', data: { agentId: 'reviewer', instruction: '检查产物并给出最终交付摘要', input: {} } },
      ],
      edges: [{ id: 'research-produce', source: 'research', target: 'produce', data: {} }, { id: 'produce-review', source: 'produce', target: 'review', data: {} }],
    } : { status: 'SUCCEEDED', summary: `演示完成：${request.instruction}`, output: { objective: request.goal.objective, note: '这是模拟产物。真实模式由智能体执行任务。', upstream: request.dependencies.map((dependency: { source: string }) => dependency.source) } };
    options.onLine?.('stdout', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } }));
    options.onLine?.('stdout', JSON.stringify({ type: 'turn.completed' }));
    finish({ code: 0, error: '' });
  }, 1300);
  return { done, stop() { clearTimeout(timer); finish({ code: 1, error: '任务已停止' }); } };
};
const config = companyConfigFromEnv({ demo });
const ctx = new Context();
ctx.plugin(companyAppPlugin, {
  ...config,
  agentsRuntime: { ...config.agentsRuntime, ...(demo ? { execute: simulate } : {}) },
});
await ctx.start();
await ctx.companyServer.ready;
console.log(`公司工作台：${ctx.companyServer.url} (${demo ? '演示模式，无模型调用' : '真实 Agent CLI 模式'})`);
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await ctx.stop(); };
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
