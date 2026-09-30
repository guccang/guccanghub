# GoalSplit DAG

独立的 TypeScript DAG 数据结构与 React 图形展示。核心没有规划器、执行器、数据库或 React 依赖。节点和边都有稳定 ID 与各自的泛型 `data`，业务功能可以直接按 ID 查询并使用这些数据。

## 模块目录

模块在仓库根目录并列：

- `dag/`：DAG 数据结构与操作。
- `agents-dag-context/`：Agent 节点上下文与文件运行模块，依赖 `dag/`。
- `agents-runtime/`：智能体 CLI 调用、Cordis 服务与 DAG 执行器。
- `company/`：任务规划与执行编排、HTTP 服务及浏览器快照同步。
- `llm/`：LLM API 接入、供应商注册、普通与流式调用。
- `cordis/`：统一服务配置、Node.js/浏览器装配、DAG 与 Agent context 服务。
- `dag-webui/`：Cordis 驱动的 React 图展示与编辑工作台。
- `pixel-studio/`：GoalHub 像素场景的显示接口、Cordis 服务及适配器。
- `public/`：共享静态资源、像素引擎与许可证。
- `examples/`：通过公开包入口操作 DAG 和 context 的外部 Cordis 程序。

包导入入口保持为 `@goalsplit/dag`、`@goalsplit/dag/agents-dag-context` 和 `@goalsplit/dag/cordis`。

## 公司任务工作台

要求 Node.js 22.12.0 或更高版本。

```sh
npm ci
npm run company:demo  # 先体验任务规划、执行与可视化，不调用真实模型
npm run company       # 使用本机已安装、认证的 Agent CLI 完成真实任务
```

访问 `http://127.0.0.1:4318`，输入目标。公司 Cordis 服务调用 agents-runtime 拆解 DAG、执行节点并保存 context；页面同步显示 DAG、节点产物和像素办公室。支持停止任务、查看本次启动的任务记录。真实模式通过 `AGENT_HOST`、`AGENT_CWD`、`AGENT_MODEL` 配置宿主。详细接口与生命周期见 [company/README.md](company/README.md)。

```sh
npm run dev    # 开发页面 4317，代理公司 API 到 4318，需同时启动公司服务
npm run check  # 类型检查、测试和构建
npm start      # 仅预览已构建页面，不启动公司服务
```

原 DAG 编辑工作台保留在 `/?mode=editor`，支持新增、删除节点与边，修改数据，导入与导出 JSON。无效边和环会被拒绝，草稿保存在浏览器 `localStorage`，编辑操作不修改公司运行任务。

## 统一 Cordis 配置

服务配置类型与默认值统一位于 `cordis/config.ts`，宿主环境变量通过 `cordis/config.node.ts` 读取。公司示例使用 `companyAppPlugin`，页面使用 `browserAppPlugin` 装配；独立插件入口继续可用。Vite 与公司 HTTP 服务共用端口配置。配置覆盖、环境变量和接入示例见 [cordis/README.md](cordis/README.md)。

## 通过 API 调用 LLM

`@goalsplit/dag/llm` 提供 Cordis `ctx.llm` 服务，参考 DeepSeek Harness 的适配器结构，实现 DeepSeek/OpenAI 兼容 Chat Completions API。支持普通和 SSE 调用、推理与工具数据、token 用量、取消和超时。

```sh
npm run example:llm             # 模拟 API
npm run example:llm -- --live   # 从环境变量读取实际 API 配置
```

注册插件、调用接口和扩展协议见 [llm/README.md](llm/README.md)。

## 调用智能体完成任务

`@goalsplit/dag/agents-runtime` 接入 `guccang/agents-runtime`，提供 `agentsRuntimePlugin` 和 `runtimeAgentsDagPlugin`。服务支持 Codex、Claude Code、DeepSeek Harness、OpenCode，管理调用、会话续接、原生事件、停止和超时；自动装配插件可直接驱动 Agent context 的 DAG 执行。

```sh
npm run example:runtime             # 模拟 CLI，经过上游事件解析器
npm run example:runtime -- --live   # 使用实际安装并认证的 CLI
```

Cordis 注册方式、执行接口、反馈协议和宿主权限策略见 [agents-runtime/README.md](agents-runtime/README.md)。

## 像素工作室

工作台已接入 GoalHub 完整像素办公室，用于显示 DAG 节点、角色和任务状态。支持角色选择、任务详情、相机缩放与减少动态。节点中的 `agentId` 和 `status` 用于投影显示，缺少状态时显示为待执行。

`@goalsplit/dag/pixel-studio` 提供 Cordis 服务及版本化显示接口，`@goalsplit/dag/pixel-studio/webui` 提供场景插件；`agentRunToStudio()` 可转换实际 Agent context 快照。接口、资源部署和来源许可见 [pixel-studio/README.md](pixel-studio/README.md)。

## 外部程序示例

```sh
npm run example
npm run example -- ./data/my-example
```

示例通过 Cordis 注册 DAG 和 Agent context 服务，演示编辑图、修改节点输入、暂停/恢复、执行、读取结果并将状态写回图。详见 [examples/README.md](examples/README.md)。

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

## Cordis 框架接入

提供 Node.js 插件入口 `@goalsplit/dag/cordis`，使用固定版本 `cordis@3.18.1`。Cordis 4.0 候选版的类型声明目前不兼容本项目的 NodeNext 配置。插件把现有 Agent 文件模块注册为 `ctx.agentsDag.runtime`；DAG 内核不导入 Cordis。Web UI 使用浏览器兼容的 `@cordisjs/core@3.18.1`，不加载 Node.js 文件模块。

```ts
import { Context } from 'cordis';
import { createDag } from '@goalsplit/dag';
import { agentsDagPlugin } from '@goalsplit/dag/cordis';

const ctx = new Context();
const fork = ctx.plugin(agentsDagPlugin, {
  rootDir: './data/agent-context',
  planner: {
    async decompose({ goal }) {
      return createDag({
        nodes: [{
          id: 'research',
          data: { agentId: 'researcher', instruction: goal.objective, input: {} },
        }],
        edges: [],
      });
    },
  },
  executor: {
    async execute(request) {
      return { status: 'SUCCEEDED', summary: '完成', output: { nodeId: request.nodeId } };
    },
  },
});

await ctx.start();
try {
  const agents = ctx.agentsDag.runtime;
  await agents.decomposeGoal('cordis-run', { objective: '完成调研', context: {} });
  console.log(await agents.executeDag('cordis-run'));
} finally {
  await ctx.stop();
}
```

其他插件可声明 `inject: ['agentsDag']`，或使用 `ctx.inject(['agentsDag'], scope => { /* 使用 scope.agentsDag.runtime */ })`，由 Cordis 管理依赖生命周期。`fork.dispose()` 卸载服务并卸载其依赖插件，磁盘运行记录保留。卸载不会取消已经开始的外部 Agent 调用；宿主应先等待正在执行的操作结束，再卸载或关闭上下文。规划器和执行器依然由宿主提供，上述示例使用演示实现。

### Cordis Web UI 插件

`@goalsplit/dag/dag-webui` 导出 `DagView` 和 `dagWebuiPlugin`；原 `@goalsplit/dag/react` 入口保持可用。浏览器宿主可按以下方式挂载：

```ts
import { Context } from "@cordisjs/core";
import { dagPlugin } from "@goalsplit/dag/cordis/dag";
import { dagWebuiPlugin } from "@goalsplit/dag/dag-webui";
import { pixelStudioPlugin, dagStudioBridgePlugin } from "@goalsplit/dag/pixel-studio";
import "@goalsplit/dag/pixel-studio/style.css";
import "@goalsplit/dag/dag-webui/style.css";
import "@goalsplit/dag/dag-webui/demo.css";

const ctx = new Context();
ctx.plugin(dagPlugin, { graph });
ctx.plugin(pixelStudioPlugin);
ctx.plugin(dagStudioBridgePlugin);
ctx.plugin(dagWebuiPlugin, { element: document.getElementById("root")! });
await ctx.start();
// 外部插件通过 ctx.dagGraph.apply(operations) 更新图。
// await ctx.stop() 卸载 UI 和服务。
```

工作台的布局样式见 `dag-webui/demo.css`，仓库演示入口已加载。上述挂载方式是独立编辑器。公司工作台通过 `companyClientPlugin` 自动同步 Node.js 宿主快照，详见公司服务文档。

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
