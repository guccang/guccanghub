# Cordis 统一配置与装配

所有服务的配置类型和默认值定义在 `cordis/config.ts`。各模块只重新导出相同类型，原有公开 API 保持可用。单次调用参数、任务数据和显示协议留在各自模块，避免配置入口承担业务逻辑。

| 入口 | 用途 | 环境 |
| --- | --- | --- |
| `@goalsplit/dag/cordis/config` | 服务配置类型、不可变 `serviceDefaults` | Node.js / 浏览器 |
| `@goalsplit/dag/cordis/config.node` | 校验并读取宿主环境变量 | Node.js |
| `@goalsplit/dag/cordis/app` | `companyAppPlugin` 统一装配服务 | Node.js |
| `@goalsplit/dag/cordis/browser` | `browserAppPlugin` 统一装配页面 | 浏览器 |

## 配置规则

- 修改公共默认值时只修改 `serviceDefaults`；服务、示例与 Vite 都从这一入口读取。
- 程序传入的插件配置覆盖默认值。独立服务仍通过各自的 `ctx.plugin()` 使用，不必装配整个应用。
- 环境变量只在 `config.node.ts` 读取。应用层负责把配置交给插件，服务不隐式读取应用环境配置。
- LLM 凭据通过回调读取，不写入配置文件，也不传给浏览器。不要打印包含 runtime `env` 的整份宿主配置。
- 装配使用 Cordis 插件与依赖注入。停止或卸载装配插件会清理子插件，取消在途请求并等待 Agent 进程退出。

默认值包括 Agent 超时 300000ms、LLM 超时 120000ms、公司最多 32 个节点/1 个并发任务/100 条进程内任务记录、HTTP 端口 4318、浏览器轮询 500ms、Vite 端口 4317、像素资源入口 `/office-engine/frame.html`。

## Node.js 公司宿主

```ts
import { Context } from 'cordis';
import { companyConfigFromEnv } from '@goalsplit/dag/cordis/config.node';
import { companyAppPlugin } from '@goalsplit/dag/cordis/app';

const ctx = new Context();
const config = companyConfigFromEnv();
ctx.plugin(companyAppPlugin, config);
await ctx.start();
try {
  await ctx.companyServer.ready;
  const task = ctx.company.submit({ objective: '分析项目并交付改进方案' });
  console.log(await ctx.company.wait(task.runId));
} finally {
  await ctx.stop();
}
```

`CompanyAppOptions` 中：`agentsRuntime` 和 `company` 必需；`companyServer` 可省略以运行无 HTTP 的宿主；`llm` 可选。配置 `llm.providers` 可注册多个 OpenAI 兼容 API 提供方，每个使用不同 ID。API 服务不会替代公司任务所用的 CLI；公司任务依然通过 agents-runtime 规划和执行。

可在传入插件前修改某一服务配置，例如 `config.companyServer` 改端口、`config.agentsRuntime.agents` 改各角色的模型和目录。模拟进程/HTTP 的函数依赖也通过此配置显式传入，不用另一套配置或服务注册系统。

### 环境变量

| 变量 | 默认 / 要求 |
| --- | --- |
| `AGENT_HOST` | `codex`；支持的宿主由 agents-runtime 定义 |
| `AGENT_CWD` | 当前工作目录 |
| `AGENT_MODEL` | CLI 默认模型 |
| `AGENT_REASONING_EFFORT` | CLI 默认推理强度 |
| `AGENT_TIMEOUT_MS` | `300000`；整数，`0` 表示不设超时 |
| `COMPANY_PORT` | `4318`；整数；`0` 由系统分配 |
| `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL` | `llmConfigFromEnv()` 的必需值 |
| `LLM_TIMEOUT_MS` | `120000`；整数，`0` 表示不设超时 |

`companyConfigFromEnv()` 使用默认 planner/researcher/builder/reviewer 角色。`runtimeConfigFromEnv(agentIds, options)` 可为其他角色读取相同宿主配置。`serverConfigFromEnv()` 供 HTTP 宿主和 Vite 代理共同读取端口，因此改变 `COMPANY_PORT` 后重启两者即可同步。

`{ demo: true }` 只强制配置 Codex 协议；模拟执行器仍须显式注入。它不会自动创建真实模型调用或模拟业务结果。示例在 `examples/` 中注入演示实现。

## 浏览器宿主

```ts
import { Context } from '@cordisjs/core';
import { browserAppPlugin } from '@goalsplit/dag/cordis/browser';
import '@goalsplit/dag/dag-webui/style.css';
import '@goalsplit/dag/dag-webui/company.css';
import '@goalsplit/dag/pixel-studio/style.css';

const ctx = new Context();
ctx.plugin(browserAppPlugin, {
  element: document.getElementById('root')!,
  mode: 'company',
  companyClient: { pollMs: 500 },
});
await ctx.start();
```

公司模式装配 DAG、办公室、HTTP 客户端和公司页面；编辑模式 `mode: 'editor'` 装配 DAG、办公室、图投影和编辑页面，可通过 `dagGraph.graph` 传入草稿。两种模式分别等待所需服务就绪再挂载，共用 React/Cordis 卸载逻辑。浏览器不导入 `config.node`、`cordis/app` 或执行服务。
