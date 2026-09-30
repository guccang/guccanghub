# GoalSplit DAG

独立的 TypeScript DAG 数据结构与 React 图形展示。核心没有规划器、执行器、数据库或 React 依赖。节点和边都有稳定 ID 与各自的泛型 `data`，业务功能可以直接按 ID 查询并使用这些数据。

## 运行演示

要求 Node.js 20 或更高版本。

```sh
npm ci
npm run dev
```

访问 http://127.0.0.1:4317 。演示页支持新增、删除节点与边，修改两者的数据，导入与导出 JSON。无效边和环会被拒绝。演示草稿保存在浏览器 `localStorage`；这是页面示例的便利功能，不属于核心 DAG 的持久化承诺。

```sh
npm run check   # 类型检查、测试和构建
npm start       # 预览已构建页面
```

## 操作 DAG

```ts
import {
  createDag, addNode, addEdge, setNodeData, setEdgeData, setEdgeEndpoints,
  removeNode, removeEdge, applyDagOperations,
  getNode, getEdge, incomingEdges, outgoingEdges,
  ancestors, descendants, topologicalOrder,
  type Dag,
} from '@goalsplit/dag';

type Task = { title: string; status?: string };
type Dependency = { label: string; required: boolean };

let graph: Dag<Task, Dependency> = createDag<Task, Dependency>();
graph = addNode(graph, { id: 'design', data: { title: '设计方案' } });
graph = addNode(graph, { id: 'review', data: { title: '评审方案' } });
graph = addEdge(graph, {
  id: 'design-review', source: 'design', target: 'review',
  data: { label: '需要设计稿', required: true },
});

graph = setNodeData(graph, 'design', { title: '设计方案', status: 'done' });
graph = setEdgeData(graph, 'design-review', { label: '设计稿已就绪', required: true });
graph = setEdgeEndpoints(graph, 'design-review', 'design', 'review');
console.log(getNode(graph, 'design')?.data.status);
console.log(getEdge(graph, 'design-review')?.data.label);
console.log(topologicalOrder(graph)); // ['design', 'review']
```

所有变更函数返回新图；节点/边结构及数组会浅冻结，业务 `data` 引用保持原样。删除节点会同时删除关联边。`applyDagOperations` 可批量操作，只校验最终图；失败时原图不变。操作会检查空 ID、重复 ID、悬空边和环，并抛出带 `code` 的 `DagError`。允许不同 ID 的平行边。`data` 作为不透明泛型值原样保留；若要遵循不可变更新，请替换数据对象而非修改其内部字段。

## 嵌入 React 图

```tsx
import { DagView } from '@goalsplit/dag/react';
import '@goalsplit/dag/react/style.css';

<div style={{ height: 500 }}>
  <DagView
    graph={graph}
    nodeLabel={node => node.data.title}
    edgeLabel={edge => edge.data.label}
    onNodeSelect={node => console.log(node.id, node.data)}
    onEdgeSelect={edge => console.log(edge.id, edge.data)}
  />
</div>
```

`DagView` 只负责展示，位置由拓扑层次计算，不写入图数据。宿主控制图和选中状态；传入新图即更新显示。布局是默认算法，适合中小型 DAG，后续可由宿主自定义布局。安装 React 相关依赖由包管理器处理。核心 API 无须浏览器环境。

旧版目标运行时、SQLite、HTTP/SSE 和规划/执行适配器已从包中移除，原 `@goalsplit/runtime` 导入路径不再适用。

## Agent 节点上下文

`@goalsplit/dag/agents-dag-context` 是可选的 Node.js 文件模块。宿主提供规划器与执行器；模块不调用真实 LLM，也不让 DAG 内核依赖文件系统。

```ts
import type { DagNode } from '@goalsplit/dag';
import { createAgentsDagContext, type PlannedAgentNode } from '@goalsplit/dag/agents-dag-context';

const agents = createAgentsDagContext({
  rootDir: './data/agent-context',
  planner: {
    async decompose({ goal }) {
      const nodes: DagNode<PlannedAgentNode>[] = [
        { id: 'research', data: { agentId: 'researcher', instruction: '收集资料', input: { topic: goal.objective } } },
        { id: 'review', data: { agentId: 'reviewer', instruction: '审核资料', input: { criteria: '准确性' } } },
      ];
      return {
        nodes,
        edges: [{ id: 'research-review', source: 'research', target: 'review', data: { required: true } }],
      };
    },
  },
  executor: {
    async execute(request) {
      return {
        status: 'SUCCEEDED',
        summary: `${request.nodeId} 已完成`,
        output: { result: request.input, upstream: request.dependencies.map(dep => dep.output) },
      };
    },
  },
});

const run = await agents.decomposeGoal('run-001', { objective: '完成调研', context: {} });
await agents.updateNodeInput(run.runId, 'review', { criteria: '准确性与完整性' });
await agents.executeDag(run.runId);
const node = await agents.getNodeContext(run.runId, 'review');
console.log(node.state.status, node.output);
```

规划结果的每个节点要包含 `agentId`、`instruction` 和 JSON 对象 `input`；每条边的 `data` 也是 JSON 对象。模块验证 DAG、给节点数据写入 `contextRef.relativeDir`，并在 `rootDir/runs/<运行摘要>/nodes/<节点摘要>/` 下保存 `input.json`、`state.json`、`feedback.json`、`output.json`。每次执行另存 `attempts/0001/input.json` 和 `feedback.json`，保留输入快照与历史尝试。文件夹名由 ID 的 SHA-256 生成，避免路径穿越和同名冲突；真实 ID 保存在运行清单与状态文件中。

执行器反馈只接受 `{ status: 'SUCCEEDED', summary: string, output: object }` 或 `{ status: 'FAILED', summary: string, output: object, error: string }`。无效反馈或执行异常会记录为固定格式 `FAILED`。上游成功的 `output.json` 和边数据会进入下游的冻结执行输入。状态历史记录 `READY / BLOCKED / RUNNING / SUCCEEDED / FAILED / PAUSED / UNKNOWN`；可使用 `pauseNode()`、`resumeNode()`、`retryNode()` 控制尚未执行或失败的节点。重启后调用 `recoverRun()`：已有反馈会补录状态，无法确认的在途调用转为 `UNKNOWN`，不会自动重复调用外部 Agent。

模块面向单个本地调度所有者；多个进程同时写入同一运行目录需要由宿主加锁。浏览器页面不能直接使用此 Node.js 文件模块，可通过宿主服务把快照传给 `DagView` 展示。
