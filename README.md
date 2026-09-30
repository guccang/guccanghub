# GoalSplit

可嵌入的 TypeScript 动态 DAG 运行时，包含 SQLite 持久化、HTTP/SSE 接口和 React 任务图面板。宿主提供规划器与执行器，本项目不接入真实 LLM、ReAct 或 Codex 服务。

## 启动演示

要求 Node.js **24.13 或更高版本**。SQLite 使用 Node 内置 `node:sqlite`，无需安装数据库服务或原生编译依赖；Node 24 会输出该模块的实验性提示。

```sh
npm ci
npm run dev
```

访问 http://127.0.0.1:4317 。创建目标，点击「执行目标」，观察并行分支和自动新增的审查节点。支持暂停、恢复、中断、节点及下游重跑、整体重跑、历史快照、节点上下文与产物下载。

```sh
npm run check        # 类型检查、自动化测试、SDK 和面板构建
npm run build
npm start            # 使用构建后的面板
```

可通过 `PORT`、`GOALSPLIT_DATA_DIR`、`GOALSPLIT_STEP_MS` 配置端口、数据目录、模拟执行步骤耗时。默认数据在 `data/`，不纳入 Git。正常终止宿主会排空正在执行的调用并保存暂停状态。

## 嵌入 TypeScript 项目

先运行 `npm run build`；可使用本地依赖或 `npm pack` 生成的包。以下示例使用随包提供的模拟端口；生产宿主替换这两个端口即可。

```ts
import { createRuntime } from '@goalsplit/runtime';
import { SqliteStore } from '@goalsplit/runtime/sqlite';
import { DemoPlanner, FakeExecutor } from '@goalsplit/runtime/testing';

// 数据库是状态的唯一事实来源，一个数据库只有一个调度所有者。
const store = new SqliteStore('./data/runtime.sqlite');
const runtime = await createRuntime({
  store,
  planner: new DemoPlanner(),
  executors: { fake: new FakeExecutor() },
  policy: { maxConcurrentTasks: 4, maxReplans: 10, noProgressLimit: 3 },
});

// commandId 在重试时必须复用，相同 ID 不得更换参数。
const runId = runtime.createRun({
  goal: { objective: '完成上线方案', constraints: [], acceptance: ['提供可验收的交付物'] },
}, 'create-release-plan');
const unsubscribe = runtime.subscribe(event => console.log(event.seq, event.type));
runtime.start(runId, 'start-release-plan');

// 读取快照不会触发执行；返回副本可以安全交给宿主。
const snapshot = runtime.getSnapshot(runId);
const events = runtime.listEvents(runId, snapshot.lastEventSeq);

// 宿主关闭时先排空调用、释放租约，再关闭数据库。
// await runtime.close();
// unsubscribe();
// store.close();
```

### 规划器协议

`PlannerPort.evaluate(snapshot, trigger, signal)` 返回以下判别联合之一。首次拆解收到空图；`REVISE` 使用 `addTask` 生成第一版图。

| 决策 | 作用 |
|---|---|
| `CONTINUE` | 推进已就绪节点；不隐式重试失败任务 |
| `REVISE` | 提交结构化操作并创建不可变图版本 |
| `WAIT` | 保存原因并进入 `WAITING_INPUT` |
| `COMPLETE` | 校验所有必需任务和证据后完成目标 |

```ts
// 必须使用本次 evaluate 收到的版本，不能使用缓存的旧版本。
return {
  type: 'REVISE',
  proposal: {
    basePlanVersion: snapshot.planVersion,
    baseStateRevision: snapshot.stateRevision,
    reason: '执行反馈表明需要补充验证',
    evidenceRefs: [],
    operations: [
      {
        type: 'addTask',
        task: {
          id: 'verify', revision: 1, title: '验证交付结果', description: '',
          executor: 'my-executor', dependencies: ['build'], context: {},
          contextRefs: [{ taskId: 'build', output: 'summary' }],
          outputs: ['summary'], resources: ['repository:demo'], required: true,
        },
      },
    ],
  },
};
```

操作包括 `addTask`、`updateTask`、`removeTask`、`addDependency`、`removeDependency`。移除节点时，必须在同一提案内修复其所有依赖与上下文引用，否则整个事务回滚。定义 revision 由运行时计算；变更影响范围取新旧图全部后继的并集。

`COMPLETE.evidenceRefs` 必须引用当前有效成功代次的 **Attempt ID 或 Artifact ID**。规划器负责对照 `Goal.acceptance` 评价实际内容；运行时检查证据存在性和任务状态，不能证明模型结论必然正确。

每个执行完成后立即停止新派发，等待其他在途任务结束再评估。评估期间用户暂停或状态变化会使旧评估作废。默认规划超时 120 秒，自动改图上限 10 次，连续 3 次没有执行进展进入等待；宿主可通过 `policy` 调整。

### 执行器协议

实现 `ExecutorPort.execute(request, context)` 和 `reconcile(attempt)`。端口的全部 TypeScript 类型及 Zod 校验模式从主入口导出。

- `request` 提供 `attemptId`、节点代次、冻结目标、用户补充、任务定义与**直接依赖**的有效结果。`contextRefs` 必须引用直接依赖声明的输出字段。
- `context.reportProgress()`、`saveHandle()`、`saveCheckpoint()` 分别保存进度、外部句柄和不透明检查点。
- `context.saveArtifact()` 先同步文件再提交数据库引用；将返回的 ID 放进最终 `artifactIds`。
- 返回 `SUCCEEDED`、`FAILED` 或 `INTERRUPTED` 结果；成功必须包含任务声明的所有输出。确认业务失败时显式返回 `FAILED`。
- 抛出异常、返回不合法结果或者丢失连接不能证明外部任务停止，因此进入 `UNKNOWN`，不会自动重试。
- 支持中断的执行器监听 `context.signal`，在确认停止后返回 `INTERRUPTED`。仅发出取消请求不表示已经停止；运行时会继续显示正在等待安全边界。
- 恢复中断任务会创建新 Attempt，并传递同代次、同输入定义的检查点。显式重跑创建新代次，从头执行。
- `reconcile()` 返回 `COMPLETED`、`RUNNING` 或 `UNKNOWN`。`RUNNING` 需提供 `observe(context)` 重新观察原执行，不能另起一次任务。

能力声明包含 `interrupt`、`checkpoint`、`idempotent`、`resourceIsolation`。默认没有能力。未声明资源隔离的执行器全局串行；声明隔离后按 `TaskSpec.resources` 的独占资源名控制跨运行并发。未知执行继续持有相关资源锁，直到核对结束。

宿主应使用 `attemptId` 作为外部幂等键并保存可核对句柄。SQLite 事务不能保证外部副作用恰好一次。

### 控制与恢复

| SDK 方法 | 行为 |
|---|---|
| `createRun` / `start` | 创建并启动，可直接传 `initialPlan` |
| `pause` / `resume` | 排空后暂停；恢复前处理待评估事项 |
| `interrupt` | 请求支持取消的执行器停止，不假设任意代码行续跑 |
| `rerunTask` | 当前节点及受影响下游创建新代次，无关结果复用 |
| `restartRun` | 从当前计划创建全新运行并启动，保留原运行 |
| `proposePlan` | 宿主在安全边界主动改图；暂停状态不被取消 |
| `addInput` | 持久化用户补充并触发边界评估，保留暂停意图 |
| `resolveAttempt` | 宿主核对后关闭未知执行，不启动新的副作用 |
| `getSnapshot(id, eventSeq?)` | 当前快照或指定事件水位之前完整提交的历史快照 |
| `listEvents` / `subscribe` | 持久化补读 / 提交后的唤醒通知 |
| `saveLayout` | 保存节点坐标，不创建新的图版本 |
| `controls` | 获取当前状态允许的界面操作 |

发生 `UNKNOWN` 时先查询外部系统，再调用 `resolveAttempt` 保存确定结果。之后通过 `resume` 或 `rerunTask` 继续；不能用改图、重跑或整体重跑绕过未知执行。

暂停中的 `rerunTask` 只准备新代次，需恢复后才派发。执行中或终结后的节点重跑会在边界启动新代次。原 Attempt、产物和旧图版本不会覆盖。

恢复时 `createRuntime` 获取数据库租约并核对未结束执行；已成功结果直接复用。默认租约 30 秒，定期续租，接管令牌递增。旧所有者失去租约后不能提交状态。用户暂停跨重启保持。

## HTTP/SSE 和 React

```ts
import express from 'express';
import { createRuntimeRouter } from '@goalsplit/runtime/http';

// 路由与业务使用同一个 runtime；示例只监听本机。
const app = express();
app.use('/api', createRuntimeRouter(runtime));
app.listen(4317, '127.0.0.1');
```

```tsx
import { RuntimePanel } from '@goalsplit/runtime/react';
import '@goalsplit/runtime/react/style.css';

// apiBase 是宿主挂载路由的地址。
export function RuntimePage() {
  return <RuntimePanel apiBase="/api" />;
}
```

| 路由 | 用途 |
|---|---|
| `GET /runs`、`POST /runs` | 列表 / 创建（含 `commandId`） |
| `GET /runs/:id?atSeq=N` | 当前或历史快照及操作能力 |
| `POST /runs/:id/commands` | `{action, commandId, taskId?, attemptId?, result?, text?}` |
| `POST /runs/:id/plans` | `{proposal, commandId}` |
| `GET /runs/:id/events?after=N` | SSE 增量流，支持 `Last-Event-ID` |
| `GET /runs/:id/history?after=N` | 每页最多 1000 条事件，按最后序号继续读取 |
| `PUT /runs/:id/layout` | 节点坐标映射 |
| `GET /runs/:id/artifacts/:artifactId` | 下载该运行的产物 |

控制 action 为 `start / pause / resume / interrupt / rerun / restart / resolve / input`。历史快照是只读查询，浏览它不会回滚真实运行。SSE 从数据库补读，通知只是加速；前端按序号去重，缺口补读，连接恢复后刷新快照。

## 存储和实施边界

- SQLite 启用 WAL、FULL 同步和外键。每次提交同时写当前快照、事件、历史快照和可选命令回执。
- 为可靠复现历史，v1 每次事务保存完整 JSON 快照，适用于单机中小规模运行。历史不自动清理，长时间高频进度上报会增加数据库大小；宿主应合并过密进度。
- 产物为内容摘要寻址的本地文件，引用时验证 SHA-256。没有自动删除历史或孤立产物的策略。
- 备份时先正常关闭 runtime 和 store，再复制整个数据目录；恢复时数据库与产物目录一起还原。运行中的数据库不要只复制主 `.sqlite` 文件。
- 本版本不包含多机调度、多租户身份管理、真实模型/工具适配器，也不把运行时数据库事务当作外部工具事务。

## 验证

`npm test` 使用 Node 测试运行器和真实 SQLite，覆盖 DAG 校验、并行与资源锁、自动改图、暂停/恢复/中断、下游失效、幂等命令、未知执行、快照历史及 HTTP/SSE。硬崩溃测试在独立子进程的三个边界调用 `process.exit`，验证提交意图和核对恢复。

开发时还使用 Playwright CLI 在 Edge 检查了创建、执行、暂停、刷新、重连、重跑、历史模式和移动端布局。截图为本地验证产物，不纳入发布包。
