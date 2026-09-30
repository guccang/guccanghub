# Cordis 公司服务

用户输入目标后，`ctx.company` 调用 `ctx.agentsRuntime` 中的规划 Agent 返回 DAG，再按拓扑顺序调用执行 Agent。输入、状态历史、反馈与产物由 `ctx.agentsDag.runtime` 持久化。浏览器通过公司 HTTP 服务取得快照，使用 `dag-webui` 与 GoalHub 像素办公室显示同一任务。

## 启动工作台

```sh
npm ci
npm run company:demo  # 演示流程，不启动真实 CLI、不调用模型
npm run company       # 真实 agents-runtime CLI 执行
```

打开 `http://127.0.0.1:4318`，输入任务并点击“开始任务”。图会显示拆解后的节点与依赖；点击节点可查看指令、状态、摘要和 JSON 产物。像素办公室按 Agent 展示工作状态，点击角色可选中其正在执行的节点。“停止任务”取消规划或当前执行节点，并阻止后续调度。

真实模式默认使用 Codex；先安装并登录所选 CLI。环境变量：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `AGENT_HOST` | `codex` | `codex`、`claudecode`、`deepseek-harness`、`opencode` |
| `AGENT_CWD` | 当前目录 | Agent 实际工作的目录 |
| `AGENT_MODEL` | CLI 默认 | 传给宿主的模型名称 |
| `COMPANY_PORT` | `4318` | 本机工作台端口 |

真实 Agent 使用该宿主已有权限和认证配置，可能执行工具或修改 `AGENT_CWD` 中的文件。CLI 配置方式见 [agents-runtime 文档](../agents-runtime/README.md)。本示例的 planner、researcher、builder、reviewer 是四个 Agent 配置，默认使用相同 CLI 与工作目录；自定义宿主可为每个角色配置不同模型、目录和超时。

开发页面：另一个终端运行 `npm run dev`，访问 `http://127.0.0.1:4317`。Vite 将 `/api/company` 代理到 `4318`。生产页面由公司服务直接提供，无需 Vite。原 DAG 草稿编辑器保留在 `/?mode=editor`，不会修改正在执行的任务图。

公司示例已经使用 `companyAppPlugin` 与统一环境配置；统一装配方式见 [Cordis 配置文档](../cordis/README.md)。下方展示独立服务接入方式。

## 外部宿主接入

```ts
import { Context } from 'cordis';
import { resolve } from 'node:path';
import { agentsRuntimePlugin } from '@goalsplit/dag/agents-runtime';
import { companyPlugin, companyServerPlugin } from '@goalsplit/dag/company';

const ctx = new Context();
ctx.plugin(agentsRuntimePlugin, {
  dataDir: resolve('./data/runtime'),
  agents: {
    planner: { hostType: 'codex', cwd: resolve('.') },
    worker: { hostType: 'codex', cwd: resolve('.') },
  },
});
ctx.plugin(companyPlugin, {
  rootDir: resolve('./data/context'),
  plannerAgentId: 'planner',
  workerAgentIds: ['worker'],
});
// 只需要程序调用时可以不注册 HTTP 服务。
ctx.plugin(companyServerPlugin, { port: 4318, staticDir: resolve('./dist/panel') });
await ctx.start();
try {
  await ctx.companyServer.ready;
  const task = ctx.company.submit({ objective: '分析项目并完成一个改进', context: {} });
  console.log(task.runId); // 立即返回 PLANNING 快照
  console.log(await ctx.company.wait(task.runId));
} finally {
  await ctx.stop();
}
```

`companyPlugin` 声明依赖 `agentsRuntime`，在同一作用域提供 `company` 与 `agentsDag`。它拥有自己的 context 规划器和执行器，不要在同一作用域再注册另一个 `agentsDag` 服务。节点运行期间请通过公司服务控制任务，避免直接调用 context 方法与调度器竞争。

| 公司服务接口 | 行为 |
| --- | --- |
| `submit({ objective, context? })` | 校验输入并启动规划，返回当前快照 |
| `list()` | 获取本次服务启动以来的任务，最新在前 |
| `getSnapshot(runId)` | 获取不可变任务快照 |
| `subscribe(listener)` | 订阅变化，返回取消订阅函数 |
| `cancel(runId)` | 停止活动调用，保留已生成的 context 与产物 |
| `wait(runId)` | 等待规划/执行退出，返回最终快照 |

配置默认最多 32 个节点、同时执行 1 个任务、本次启动最多 100 个任务；可通过 `maxNodes`、`maxConcurrentTasks`、`maxTasks` 修改。取消后须等待活动 CLI 退出，才释放并发槽位。默认串行调度，即使有独立分支也按拓扑顺序执行。

## 规划和执行协议

规划 Agent 的最终回复必须仅为 JSON：

```json
{
  "nodes": [
    { "id": "analyze", "data": { "agentId": "worker", "instruction": "分析并给出验收条件", "input": {} } },
    { "id": "deliver", "data": { "agentId": "worker", "instruction": "根据上游结果交付产物", "input": {} } }
  ],
  "edges": [{ "id": "handoff", "source": "analyze", "target": "deliver", "data": {} }]
}
```

图会经过无环、引用、节点数和 Agent 白名单校验。无效规划标记为 `FAILED`，不会启动执行节点，也不会把格式错误的回复当作完成结果。

节点调用由 agents-runtime 的 context 执行适配完成：输入包含目标、指令、节点 input、上游 output 和依赖边数据。返回固定 `SUCCEEDED`/`FAILED` 反馈协议。失败下游保持 `BLOCKED`；独立分支继续执行。最终仅当所有节点成功，公司任务才为 `SUCCEEDED`。取消中的节点可能保存为 `FAILED`，公司任务仍标记为 `CANCELLED`，不会再执行下游。

任务快照含 `run`（图和节点状态）、`feedback`（摘要与产物）和 `studio`（像素显示协议）。规划期间只有负责人工作；执行期间由节点分配的 Agent 展示状态。同一快照通过递增 `revision` 同步，停止和失败会投影到人物状态。

## HTTP 和浏览器接入

| 接口 | 行为 |
| --- | --- |
| `GET /api/company/tasks` | 列出当前任务 |
| `POST /api/company/tasks` | JSON `{ "objective": "任务", "context": {} }`，返回 202 |
| `GET /api/company/tasks/:runId` | 读取快照 |
| `POST /api/company/tasks/:runId/cancel` | JSON `{}`，停止任务 |

HTTP 插件只监听 `127.0.0.1`，检查 Host、Origin 和跨站请求标记；没有提供跨用户鉴权或远程部署接口。静态目录应只包含公开页面资源，不要指向 context 或 runtime 数据目录。

独立浏览器宿主也可通过公开入口装配：

```ts
import { Context } from '@cordisjs/core';
import { dagPlugin } from '@goalsplit/dag/cordis/dag';
import { pixelStudioPlugin } from '@goalsplit/dag/pixel-studio';
import { companyClientPlugin } from '@goalsplit/dag/company/client';
import { companyWebuiPlugin } from '@goalsplit/dag/dag-webui';
import '@goalsplit/dag/dag-webui/style.css';
import '@goalsplit/dag/dag-webui/company.css';
import '@goalsplit/dag/pixel-studio/style.css';

const ctx = new Context();
ctx.plugin(dagPlugin);
ctx.plugin(pixelStudioPlugin);
ctx.plugin(companyClientPlugin); // 默认同源 /api/company
ctx.plugin(companyWebuiPlugin, { element: document.getElementById('root')! });
await ctx.start();
```

公司页面等待必需服务就绪后挂载；不要同时注册草稿图的 `dagStudioBridgePlugin`，避免覆盖任务显示。将 `public/office-engine` 部署到同源 `/office-engine`。

浏览器使用 `@goalsplit/dag/company/client` 中的 `companyClientPlugin`，声明依赖 `dagGraph`、`pixelStudio`。它每 500ms 获取任务快照并投影到图和办公室，可调用 `ctx.companyClient.submit(objective)`、`select(runId)`、`cancel()`，并通过 `getSnapshot`/`subscribe` 读取 UI 状态。停止浏览器 Cordis context 会清理轮询和 HTTP 请求。断线时保留最近画面并标记离线，恢复连接后重新同步。

context 文件保存在 `data/company-context/`，CLI 配置保存在 `data/company-runtime/`。任务列表目前为进程内记录；重启不会自动重发任务或恢复页面历史，磁盘节点记录仍保留。需要人工恢复时可按 context 模块的 `recoverRun()` 协议处理未知状态。卸载公司插件会取消调用并等待退出。
