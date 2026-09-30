# 外部 Cordis 程序

在仓库根目录运行：

```sh
npm ci
npm run example
# 可选：指定 context 数据目录
npm run example -- ./data/my-example
```

`cordis-app.ts` 通过 `@goalsplit/dag` 的公开入口导入，不直接引用内部源文件。命令先构建，再用 Node.js 执行编译后的宿主程序，验证实际包导出。每次创建新的运行 ID，文件默认保存在 `data/examples/cordis-app/`。

程序注册 `dagPlugin` 和 `agentsDagPlugin`，通过 `ctx.dagGraph` 批量新增节点与边、修改节点，再将图交给规划器校验和建立 context。随后修改节点输入、暂停与恢复节点、执行依赖链，读取结果并把状态写回 DAG。终端输出 graph、review context 和运行目录。执行器是本地演示实现，可替换为外部 Agent 调用。

`dag-webui/` 的 Cordis 插件订阅 `dagGraph` 服务并展示变更；浏览器使用 `@cordisjs/core`，文件 context 使用 Node.js `cordis`。示例与浏览器是独立进程，未配置网络同步。需要共享实时数据时，由宿主提供 HTTP/WebSocket 等传输，再将快照交给浏览器的 `dagGraph.setGraph()`。

程序还通过 `agentRunToStudio()` 将最终 context 转换为像素工作室快照并发布到 Cordis `pixelStudio` 服务，终端输出 `studio` 数据；可将该协议数据传给浏览器显示接口。

## 智能体 Runtime 示例

`npm run example:runtime` 运行 `agents-runtime-app.ts`，通过公开 Cordis 服务调用上游解析器，再执行 DAG 和发布像素显示快照。默认模拟 CLI；显式添加 `-- --live` 使用真实宿主。配置与权限策略见 [../agents-runtime/README.md](../agents-runtime/README.md)。

## LLM API 示例

`npm run example:llm` 通过公开 Cordis `ctx.llm` 接口演示普通 JSON 与 SSE 流式调用。默认模拟 HTTP；使用 `-- --live` 并配置 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY` 调用实际 API。详见 [../llm/README.md](../llm/README.md)。

## 公司任务宿主

`company-app.ts` 通过公开 Cordis 插件注册 agents-runtime、公司任务服务和本机 HTTP 服务。`npm run company` 使用真实 CLI 完成规划与执行；`npm run company:demo` 使用模拟 Codex 事件展示完整交互。访问 `http://127.0.0.1:4318` 输入任务，同时观察 DAG 和像素办公室。详见 [公司服务文档](../company/README.md)。

## 统一配置

示例中的宿主环境变量由 `@goalsplit/dag/cordis/config.node` 读取。公司宿主通过 `companyAppPlugin` 装配，浏览器入口通过 `browserAppPlugin` 装配。模拟实现继续只放在示例中；公共配置与默认值见 [Cordis 配置文档](../cordis/README.md)。
