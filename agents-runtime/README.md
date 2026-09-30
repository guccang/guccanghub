# Agent Runtime 的 Cordis 接入

独立模块 `agents-runtime/` 基于 `@guccang/agents-runtime`，固定使用上游提交 `15ae29e86e6cd257bc6c22acc3a5001f1fe6714f`。支持 `codex`、`claudecode`、`deepseek-harness`、`opencode` 四种宿主。依赖通过 Git HTTPS 安装，要求 Node.js 22.12.0 或更新版本。

本模块仅在 Node.js 运行；浏览器通过显示协议接收状态，不直接导入 CLI、凭据或原生事件。

## 注册与直接调用

```ts
import { Context } from 'cordis';
import { agentsRuntimePlugin } from '@goalsplit/dag/agents-runtime';

const ctx = new Context();
ctx.plugin(agentsRuntimePlugin, {
  dataDir: '/absolute/path/to/data/agents-runtime',
  agents: {
    researcher: { hostType: 'codex', cwd: '/absolute/path/to/project', model: 'your-model', timeoutMs: 300000 },
    reviewer: { hostType: 'claudecode', cwd: '/absolute/path/to/project' },
  },
});
await ctx.start();
try {
  const result = await ctx.agentsRuntime.run({
    id: 'task-1', agentId: 'researcher', input: '分析项目结构，返回说明。',
  });
  console.log(result.code, result.error, result.sessionId, result.finalMessage);
} finally {
  await ctx.stop();
}
```

宿主 CLI 需预先安装和认证。`dataDir` 传给上游 `hostEnvironment()`，读取独立宿主设置并创建子进程环境；不修改服务进程的环境变量。`env` 可指定父环境。模型和工作目录由宿主的 Agent 配置决定，任务仅按 `agentId` 选择配置，不能在任务输入中覆盖工作目录或认证。

上游 CLI 权限策略保持不变：Codex 使用 `--dangerously-bypass-approvals-and-sandbox`，Claude Code 使用 `--dangerously-skip-permissions`，DeepSeek 环境使用 `danger-full-access`。这些 CLI 可操作配置的工作目录及其权限允许的资源；宿主应按实际运行环境配置目录和隔离方式。

## 服务接口

| 接口 | 行为 |
| --- | --- |
| `run(task, options?)` | 等待最终结果；返回退出码、错误、会话 ID、最终回复和是否停止 |
| `startTask(task, options?)` | 返回 `{ id, done, stop() }`，由 Cordis 跟踪在途任务 |
| `stopTask(taskId)` | 请求停止指定任务；返回任务是否仍在执行 |
| `activeTaskIds` | 当前在途任务 ID 的独立快照 |
| `execute(dagRequest, options?)` | 适配现有 `AgentExecutorPort`，返回严格的节点 JSON 反馈 |
| `shutdown()` | 停止所有在途任务并等待结算，拒绝后续启动；插件卸载时自动调用 |

`RuntimeTask` 包含 `id`、`agentId`、`input`，以及可选的本地图片绝对路径 `images` 和显式续接 `sessionId`。在途任务 ID 不可重复。不同节点或尝试不会自动共用会话；宿主自行保存并传入会话 ID。

`options.signal` 支持 AbortSignal。超时优先级为调用 options、Agent 配置、服务配置、默认 300000 毫秒；`timeoutMs: 0` 关闭超时。取消、停止和超时即使随后得到退出码 0 也保留失败原因。插件卸载会停止子进程并等待上游 `done`；上游进程实现负责终止进程组及有界停止等待。

原生事件通过 Cordis 发布：

```ts
ctx.on('agents-runtime/event', event => {
  // event: { taskId, agentId, type, text }
  // 原始诊断或工具输出属于服务端数据，按需过滤后再展示。
});
ctx.on('agents-runtime/session', event => {
  // event: { taskId, agentId, sessionId }
  // 由宿主持久化会话 ID；DAG 成功反馈不自动添加协议外字段。
});
```

订阅器异常不会中断宿主执行。事件可能在 `startTask()` 返回前同步到达，因此在启动任务前注册监听。

## DAG / context 自动装配

```ts
import { runtimeAgentsDagPlugin } from '@goalsplit/dag/agents-runtime';
import { createDag } from '@goalsplit/dag';

// 与 agentsRuntimePlugin 注册在同一 Context。
ctx.plugin(runtimeAgentsDagPlugin, {
  rootDir: '/absolute/path/to/data/agent-context',
  planner: {
    async decompose({ goal }) {
      return createDag({
        nodes: [{ id: 'research', data: { agentId: 'researcher', instruction: goal.objective, input: {} } }],
        edges: [],
      });
    },
  },
});
await ctx.start();
const run = await ctx.agentsDag.runtime.decomposeGoal('run-1', { objective: '分析项目', context: {} });
await ctx.agentsDag.runtime.executeDag(run.runId);
console.log(await ctx.agentsDag.runtime.getNodeContext(run.runId, 'research'));
```

该插件声明 `inject: ['agentsRuntime']`，自动将服务作为 context 的执行器。不要在同一服务域同时注册 `agentsDagPlugin` 和 `runtimeAgentsDagPlugin`，二者都提供 `agentsDag`。

执行器把目标、节点指令、输入和上游依赖完整传给 CLI，并要求最终回复为以下格式之一：

```json
{"status":"SUCCEEDED","summary":"完成摘要","output":{"result":"业务结果"}}
```

```json
{"status":"FAILED","summary":"失败摘要","output":{},"error":"失败原因"}
```

非 JSON、Markdown 代码块、额外字段、无效输出、宿主错误和非零退出码都转换为 `FAILED`；上游失败不会放行下游。合法反馈仍是智能体的业务自述，如需独立验收，由宿主补充验收策略。现有 context 模块继续负责输入快照、尝试记录、恢复、暂停和显式重试；本接入不自动重发模型调用。

`ctx.agentsRuntime.execute(request, { sessionId, images, signal, timeoutMs })` 可显式提供节点调用选项。若每个节点需要不同选项，可使用现有 `agentsDagPlugin`，注入 runtime 后自行包装 `executor.execute`；自动装配插件使用默认选项。

## 示例与测试

```sh
npm run example:runtime             # 模拟 CLI，不需要模型凭据
npm run example:runtime -- --live   # 调用配置的真实 CLI
```

真实示例可通过 `AGENT_HOST`、`AGENT_MODEL`、`AGENT_CWD`、`AGENT_TASK` 配置宿主、模型、目录和目标。未指定宿主时默认 Codex。示例还把 context 结果转换为像素工作室快照；浏览器联网传输仍由宿主提供。

`AgentsRuntimeOptions.execute` 支持传入上游 `createHostExecutor()` 的执行器或测试替身。DeepSeek ACP 替身还必须实现 `write()` 和 `endInput()`。默认示例注入模拟 JSONL，仍经过上游真正的事件解析器，测试不访问真实模型。

验证使用 `npm run check`。上游未提供 TypeScript 声明，本模块在 `upstream.ts` 中为实际使用的接口提供窄类型桥接；升级上游需同步验证该契约和原生事件解析。

`ctx.agentsRuntime.agentIds` 返回配置中的 Agent ID 列表，不包含模型、工作目录或凭据，可用于上层公司服务校验角色配置。
