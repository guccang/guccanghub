# LLM API 接入层

`llm/` 是与其他模块并列的服务端 API 调用层，不需要智能体 CLI。通过 Cordis 提供 `ctx.llm`，供应商协议由单独插件适配。

参考 DeepSeek Harness 提交 `639ed015397290b3745d163aafe02ffee4aa3f84` 的设计：

- [`packages/llm/llm/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/llm/llm/src/index.ts)：模型服务与适配器注册。
- [`packages/llm/llm/src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/llm/llm/src/types.ts)：供应商无关的消息、分片、结束原因与用量。
- [`packages/llm/llm-deepseek/src/transport.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/llm/llm-deepseek/src/transport.ts) 和 `sse.ts`：传输错误分类与完整 SSE 帧处理。

这是基于上述结构独立实现的精简层，使用本项目的 Cordis 3.18.1；不依赖 Harness 内部的 Messages、typert、文件服务或 agent loop。首个适配器对接公开的 [DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/) 和相同 wire format 的兼容网关。

## Cordis 注册与调用

```ts
import { Context } from 'cordis';
import { llmPlugin, deepseekLlmPlugin } from '@goalsplit/dag/llm';

const ctx = new Context();
ctx.plugin(llmPlugin, { timeoutMs: 120000 });
ctx.plugin(deepseekLlmPlugin, {
  id: 'deepseek',
  apiKey: () => process.env.DEEPSEEK_API_KEY!,
  // 默认 API 根地址为 https://api.deepseek.com。
});
await ctx.start();
try {
  const response = await ctx.llm.generate({
    provider: 'deepseek',
    model: process.env.DEEPSEEK_MODEL!,
    messages: [{ role: 'user', content: '用一句话解释 DAG。' }],
    maxTokens: 1024,
  });
  console.log(response.text, response.usage);
} finally {
  await ctx.stop();
}
```

其他兼容网关使用 `openAiCompatiblePlugin`，指定 `id`、`baseURL` 和 `apiKey`。`baseURL` 是 API 根路径，适配器追加 `/chat/completions`；如地址为 `https://gateway.example/v1`，实际请求路径为 `/v1/chat/completions`。HTTP(S) 重定向默认拒绝。API Key 可为字符串或每次调用时读取的异步函数，便于宿主轮换凭据。凭据加载函数应及时返回；若自行进行异步外部查询，该查询的取消由宿主负责。

## 服务接口

| 接口 | 作用 |
| --- | --- |
| `generate(request, options?)` | 普通 JSON 请求，汇总文本、推理、工具调用、结束原因与用量 |
| `stream(request, options?)` | SSE 请求，返回 `AsyncIterable<LlmChunk>`；消费时才发起网络调用 |
| `registerAdapter(adapter)` | 注册唯一供应商 ID，返回卸载函数 |
| `listProviders()` | 已注册供应商及其配置的模型名列表，不包含凭据或连接地址 |
| `activeRequestCount` | 当前在途调用数量 |
| `shutdown()` | 中止调用、清除注册；插件卸载时自动执行 |

请求包含 `provider`、`model`、`messages`，以及可选的 `tools`、`temperature`、`maxTokens`、`responseFormat`、`reasoningEffort`。模型列表仅为配置的静态目录，不自动请求供应商模型发现接口，也不限制调用其他模型名；模型可用性由 API 确认。

消息支持 system/user 文本、assistant 文本或工具调用、tool 结果。assistant 的 `reasoning` 对应兼容协议的 `reasoning_content`，用于需要续传推理数据的模型。当前不支持多模态附件，也不自动执行工具或追加后续轮次。

```ts
for await (const chunk of ctx.llm.stream(request, { signal: abortController.signal })) {
  if (chunk.type === 'text') process.stdout.write(chunk.text);
}
```

分片类型包括 `text`、`reasoning`、`tool-call`、`usage` 和 `finish`。工具参数按原始 JSON 字符串分片返回，消费者按 `index` 拼接；`generate()` 返回组装后的 `toolCalls`。工具参数校验和实际执行由宿主负责。

结束原因为 `stop`、`tool-calls`、`max-tokens`。`max-tokens` 明确表示输出截断，不能当成完整业务结果；使用 `responseFormat: 'json_object'` 时仍应在提示中要求 JSON，并由调用者解析及校验返回文本。

用量字段 `inputTokens` 是供应商报告的输入总量，已包含缓存命中；`cacheReadTokens` 是其子集，不与输入量重复相加。`outputTokens` 和 `totalTokens` 沿用供应商统计，供应商未提供用量时 `usage` 不存在。推理内容与普通文本分开返回。

## 生命周期与错误

调用 `options.signal` 支持取消；`options.timeoutMs` 覆盖服务默认超时，`0` 关闭超时。超时覆盖请求头、响应体和 SSE 消费；流消费者暂停拉取也会触发截止时间。提前 `break` 会关闭流并取消响应体。关闭服务或卸载供应商会中止所属在途请求。自定义适配器必须遵守传入的 AbortSignal。

`LlmError.code` 提供稳定分类：`AUTH`、`QUOTA`、`RATE_LIMIT`、`SERVER`、`NETWORK`、`TIMEOUT`、`ABORTED`、`NO_ADAPTER`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`INVALID_REQUEST`、`MALFORMED_RESPONSE`、`EMPTY_RESPONSE`、`CLOSED`、`HTTP`。HTTP 错误保留状态码、`retryAfterMs` 和供应商 request ID，不保留原始正文、密钥或请求内容。

流式调用要求完整 SSE 帧、最终结束原因和 `[DONE]` 标记；传输截断不会冒充成功。分片可能已交给消费者，后续错误仍会通过迭代器抛出。当前不自动重试，也不在流式输出后悄悄重新请求模型；宿主按错误分类与 Retry-After 明确决定重试策略。

## 扩展供应商

插件声明 `inject: ['llm']`，实现 `LlmAdapter.stream(request, context)` 并注册。`context.streaming` 区分普通调用与流式调用，`context.signal` 管理取消。适配器把 wire format 转成公共分片，必须最终返回一次 `finish`；解注册取消同供应商在途调用。

```ts
const providerPlugin = {
  name: 'custom-llm-provider',
  inject: ['llm'],
  apply(ctx, options) {
    const dispose = ctx.llm.registerAdapter(new CustomAdapter(options));
    ctx.on('dispose', dispose);
  },
};
```

API 调用没有 CLI 工作目录、会话进程或工具执行权限。现有 `agents-runtime/` 继续负责智能体 CLI；宿主可在 planner/executor 内通过 `ctx.llm` 调用模型，context 的持久化和调度保持由对应 Cordis 服务负责。

## 示例

```sh
npm run example:llm
LLM_BASE_URL=https://api.deepseek.com LLM_MODEL=your-model LLM_API_KEY=your-key npm run example:llm -- --live
```

默认示例注入模拟 HTTP 响应，演示普通和流式 API。真实调用读取环境变量，使用安装环境支持的模型与凭据。模块仅服务端导入，浏览器展示需通过宿主接口转发经过筛选的数据。

`npm run check` 验证类型、测试和构建；测试包含真实本地 HTTP 服务、UTF-8/SSE 分片、工具数据、错误分类、断流、取消、超时与卸载，无需真实模型凭据。
