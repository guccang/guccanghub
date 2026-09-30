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

此次范围聚焦 DAG 结构及展示；旧版目标运行时、SQLite、HTTP/SSE 和规划/执行适配器已从包中移除，原 `@goalsplit/runtime` 导入路径不再适用。
