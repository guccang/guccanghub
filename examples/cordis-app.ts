/** 外部宿主程序：只通过包的公开入口使用 DAG、context 和 Cordis。 */
import { Context } from 'cordis';
import { createDag, setNodeData } from '@goalsplit/dag';
import { assertJsonObject, validatePlannedDag } from '@goalsplit/dag/agents-dag-context';
import { agentsDagPlugin, dagPlugin } from '@goalsplit/dag/cordis';
import { pixelStudioPlugin, agentRunToStudio } from '@goalsplit/dag/pixel-studio';
import { resolve } from 'node:path';

const rootDir = resolve(process.argv[2] ?? './data/examples/cordis-app');
const runId = `example-${Date.now()}-${process.pid}`;
const ctx = new Context();
ctx.plugin(dagPlugin);
ctx.plugin(pixelStudioPlugin);
ctx.plugin(agentsDagPlugin, {
  rootDir,
  planner: {
    async decompose() {
      // 外部程序定义的图进入 context；仍通过规划结果校验。
      const graph = ctx.dagGraph.getSnapshot();
      return validatePlannedDag(createDag({
        nodes: graph.nodes.map(({ id, data }) => {
          if (typeof data.agentId !== 'string' || typeof data.instruction !== 'string') {
            throw new TypeError(`${id} 缺少 Agent 配置`);
          }
          assertJsonObject(data.input, `${id}.input`);
          return { id, data: { agentId: data.agentId, instruction: data.instruction, input: data.input } };
        }),
        edges: graph.edges.map(edge => {
          assertJsonObject(edge.data, `${edge.id}.data`);
          return { ...edge, data: edge.data };
        }),
      }));
    },
  },
  executor: {
    async execute(request) {
      return {
        status: 'SUCCEEDED',
        summary: `${request.nodeId} 完成`,
        output: {
          agentId: request.agentId,
          input: request.input,
          upstream: request.dependencies.map(dep => dep.output),
        },
      };
    },
  },
});

await ctx.start();
try {
  const dag = ctx.dagGraph;
  dag.apply([
    { type: 'addNode', node: { id: 'research', data: { agentId: 'researcher', instruction: '收集资料', input: { topic: 'Cordis' } } } },
    { type: 'addNode', node: { id: 'review', data: { agentId: 'reviewer', instruction: '审核资料', input: { criteria: '准确性' } } } },
    { type: 'addEdge', edge: { id: 'research-review', source: 'research', target: 'review', data: { required: true } } },
  ]);
  dag.setGraph(setNodeData(dag.getSnapshot(), 'research', {
    ...dag.getSnapshot().nodes.find(node => node.id === 'research')!.data,
    instruction: '收集 Cordis 框架接入资料',
  }));

  const agents = ctx.agentsDag.runtime;
  await agents.decomposeGoal(runId, { objective: '演示外部程序操作 DAG 与 context', context: { source: 'examples' } });
  await agents.updateNodeInput(runId, 'review', { criteria: '准确性与完整性' });
  await agents.pauseNode(runId, 'review');
  await agents.executeNode(runId, 'research');
  await agents.resumeNode(runId, 'review');
  const snapshot = await agents.executeDag(runId);
  const review = await agents.getNodeContext(runId, 'review');

  // 将 context 的状态写回外部图，可直接传给 Web UI。
  dag.apply(snapshot.graph.nodes.map(node => ({
    type: 'setNodeData' as const,
    id: node.id,
    data: { ...node.data, status: snapshot.states[node.id].status },
  })));
  ctx.pixelStudio.publish(agentRunToStudio(snapshot, { revision: 1 }));
  console.log(JSON.stringify({ rootDir, runId, graph: dag.getSnapshot(), review, studio: ctx.pixelStudio.getSnapshot() }, null, 2));
} finally {
  await ctx.stop();
}
