# 像素工作室

显示模块复用 GoalHub 的完整像素办公室引擎，通过独立显示协议接入 DAG 或 Agent context。`pixel-studio/` 与 `dag/`、`agents-dag-context/`、`cordis/`、`dag-webui/` 并列。它不启动 Agent、不修改 context，也不承担调度。

## 显示接口

`StudioSnapshot` 是版本化的可序列化数据：

| 字段 | 含义 |
| --- | --- |
| `version` | 当前协议版本 `1` |
| `runId` | 当前运行或显示空间的稳定 ID；切换时清除选中状态 |
| `revision` | 同一运行内严格递增的快照版本 |
| `title` | 显示目标标题 |
| `actors` | 角色 ID、姓名、形象、状态、活动和可选负责人标记 |
| `tasks` | 任务 ID、标题、角色 ID 与状态 |
| `handoffs` | 按 `sequence` 严格递增的交接事件；发送端可保留历史或发送增量 |

状态为 `idle / working / blocked / paused / success / error / unknown`。`unknown` 明确显示“结果待确认”，不会变成工作动画。仅 `working` 表示正在执行。环境散步和咖啡动画不代表业务执行。

`StudioDisplayPort` 是宿主的最小接入契约：

- `publish(snapshot, { reconnect? })`：验证并复制冻结快照；返回是否接收了新版本。旧版本和重复版本不覆盖现有数据。首次连接、切换运行和显式重连建立事件基线，不重播历史交接。
- `getSnapshot()` / `subscribe(listener)`：读取显示状态、订阅变更；返回值中的 `connectionEpoch` 用于识别重连基线。取消订阅函数和 Cordis 卸载会清理监听。
- `setConnected(false)`：保留上次快照并冻结人物动态；恢复连接或调用 `publish(..., { reconnect: true })` 后建立新基线。
- `selectActor(id | null)`：选择或清除角色；非法 ID 被拒绝。

角色选择和场景道具点击通过 `StudioInteraction` 回传宿主：`select-actor`、`navigate`。宿主决定后续操作，显示模块不直接调用执行器。`human` 为交接的保留端点，不生成像素人物。

## Cordis 接入

```ts
import { Context } from '@cordisjs/core';
import { pixelStudioPlugin } from '@goalsplit/dag/pixel-studio';
import { pixelStudioWebuiPlugin } from '@goalsplit/dag/pixel-studio/webui';
import '@goalsplit/dag/pixel-studio/style.css';

const ctx = new Context();
ctx.plugin(pixelStudioPlugin);
ctx.plugin(pixelStudioWebuiPlugin, {
  element: document.getElementById('studio')!,
  onInteraction(event) { console.log(event); },
});
await ctx.start();
ctx.pixelStudio.publish({
  version: 1, runId: 'run-1', revision: 1, title: '调研任务',
  actors: [{ id: 'researcher', name: '研究员', character: 'jim', status: 'working', activity: '收集资料' }],
  tasks: [{ id: 'research', actorId: 'researcher', title: '收集资料', status: 'working' }],
  handoffs: [],
});
// await ctx.stop() 卸载场景与服务。
```

Node.js 宿主可使用 `cordis` 的 `Context` 注册同一服务，并通过 `agentRunToStudio(runSnapshot, { revision, actors?, handoffs? })` 转换实际 context 快照。多个节点属于同一个 `agentId` 时合并为一个人物，状态按执行中、未知、失败、暂停、阻塞、待执行、成功的优先级汇总。适配器不推测交接事件；真实事件由宿主显式提供。

`dagStudioBridgePlugin` 是可选的编辑器投影插件，依赖 `dagGraph` 和 `pixelStudio`。它根据节点的 `agentId`、`label`/`instruction`、`status` 更新场景；缺少 `agentId` 时按节点 ID 生成显示角色，缺少状态时显示为待执行。接入真实 context 数据源时，使用宿主发布替代此投影，避免两个数据源覆盖同一服务。

## 浏览器资源与隔离

`public/office-engine/` 包含原构建引擎、图集、显示桥接页面和许可证。Vite 开发及生产构建会将这些文件提供在 `/office-engine/`。包发布也包含该目录；其他宿主须将目录复制到其静态资源根目录，再挂载 UI。

`PixelStudio` 的 `frameUrl` 默认 `/office-engine/frame.html`，必须与宿主同源。引擎内图集使用 `/office-engine/assets/` 的绝对路径，宿主需保留此资源路径。每个显示实例在独立 iframe 中运行，隔离上游引擎的单例状态。消息仅接受对应窗口和同源来源；卸载销毁 iframe 场景及事件订阅。

HTTP、WebSocket 或其他 Cordis 服务的数据适配器只需发布协议快照并维护 revision、重连标记和真实交接序号。当前工作台已接入本地 DAG 投影；外部 Node.js 示例与浏览器未自动跨进程联网。

## 来源与许可

来源：`https://github.com/guccang/goalhub`，提交 `0a1dedf3f247ec2f9120accd3c50e6926518f473`，原始目录 `public/office-engine/`。保留原引擎，修正三个图集 URL 的 `?url` 后缀，避免 Vite 开发服务器将图像请求转换为 JavaScript 模块；其余引擎代码不变。新增 `frame.html` 和 `frame.js` 用于显示接口适配。文件摘要见 `UPSTREAM.json`。

原场景来自 Munder Difflin / Chaitanya Giri，代码许可见 `public/office-engine/LICENSE.txt`；构建依赖许可见 `THIRD-PARTY-LICENSES.txt` 和 `engine.js.LEGAL.txt`。像素素材由 LimeZu 创作，素材许可独立于 MIT，详见 `ASSET-LICENSE.txt`、`LICENSE-ASSETS`、`ATTRIBUTION.md`。保持署名，素材随场景使用，不作为独立素材包分发。
