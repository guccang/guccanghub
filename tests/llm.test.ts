import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { Context } from 'cordis';
import { llmPlugin, openAiCompatiblePlugin, LlmError, type LlmChunk, type LlmRequest } from '../llm/index.js';
const request: LlmRequest = { provider: 'test', model: 'model', messages: [{ role: 'user', content: '你好' }] };
const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 6 };
const response = { choices: [{ message: { content: '你好', reasoning_content: '思考' }, finish_reason: 'stop' }], usage };
async function context(fetcher: typeof fetch) {
  const ctx = new Context();
  ctx.plugin(llmPlugin);
  const provider = ctx.plugin(openAiCompatiblePlugin, { id: 'test', baseURL: 'https://mock.example/v1', apiKey: ' secret-key ', fetch: fetcher });
  await ctx.start(); return { ctx, provider };
}
const errorCode = (code: string) => (error: unknown) => error instanceof LlmError && error.code === code;
async function consume(iterable: AsyncIterable<LlmChunk>) { const chunks: LlmChunk[] = []; for await (const chunk of iterable) chunks.push(chunk); return chunks; }

test('JSON API 调用转换请求、推理与缓存用量，结果不暴露凭据', async () => {
  const { ctx } = await context(async (url, options) => {
    assert.equal(String(url), 'https://mock.example/v1/chat/completions');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer secret-key');
    const input = JSON.parse(String(options?.body));
    assert.equal(input.stream, false);
    assert.equal(input.response_format.type, 'json_object');
    assert.equal(input.max_tokens, 100);
    assert.equal(input.reasoning_effort, 'high');
    assert.equal(input.messages[1].tool_calls[0].function.name, 'lookup');
    assert.equal(input.messages[2].tool_call_id, 'call');
    return Response.json(response);
  });
  try {
    const result = await ctx.llm.generate({ ...request, responseFormat: 'json_object', maxTokens: 100, reasoningEffort: 'high', messages: [...request.messages, { role: 'assistant', content: null, toolCalls: [{ id: 'call', name: 'lookup', arguments: '{}' }] }, { role: 'tool', content: '资料', toolCallId: 'call' }] });
    assert.equal(result.text, '你好'); assert.equal(result.reasoning, '思考');
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheReadTokens: 6 });
    assert.ok(Object.isFrozen(result));
    assert.equal(JSON.stringify(ctx.llm.listProviders()).includes('secret-key'), false);
    assert.equal(ctx.llm.activeRequestCount, 0);
  } finally { await ctx.stop(); }
});

test('SSE 正确处理跨字节 UTF-8、CRLF、多行 data、工具参数和末尾用量', async () => {
  const frames = [
    ': heartbeat\r\n\r\n',
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '想一想', content: '你好' }, finish_reason: null }] })}\r\n\r\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'lookup', arguments: '{"q":' } }] }, finish_reason: null }] })}\n\n`,
    'data: {"choices":\ndata: [{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    `data: ${JSON.stringify({ choices: [], usage })}\n\n`, 'data: [DONE]\n\n',
  ].join('');
  const bytes = new TextEncoder().encode(frames);
  const { ctx } = await context(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } }));
  try {
    const chunks = await consume(ctx.llm.stream(request));
    assert.ok(chunks.some(chunk => chunk.type === 'text' && chunk.text === '你好'));
    assert.ok(chunks.some(chunk => chunk.type === 'reasoning' && chunk.text === '想一想'));
    assert.equal(chunks.filter(chunk => chunk.type === 'tool-call').map(chunk => chunk.arguments).join(''), '{"q":1}');
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'tool-calls' });
    assert.equal(chunks.at(-2)?.type, 'usage');
  } finally { await ctx.stop(); }
});

test('HTTP 分类保留 Retry-After，错误不回显正文或密钥', async () => {
  for (const [status, code] of [[401, 'AUTH'], [402, 'QUOTA'], [429, 'RATE_LIMIT'], [500, 'SERVER']] as const) {
    const { ctx } = await context(async () => new Response('secret-key sensitive-request', { status, headers: { 'retry-after': '2', 'x-request-id': 'req' } }));
    try {
      await assert.rejects(ctx.llm.generate(request), error => {
        assert.ok(error instanceof LlmError); assert.equal(error.code, code); assert.equal(error.retryAfterMs, 2000); assert.equal(error.requestId, 'req'); assert.equal(error.message.includes('secret-key'), false); return true;
      });
    } finally { await ctx.stop(); }
  }
});

test('截断 SSE、无效 JSON、空响应和缺少结束原因明确失败', async () => {
  for (const body of ['data: {not-json}\n\n', 'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']) {
    const { ctx } = await context(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    try { await assert.rejects(consume(ctx.llm.stream(request)), error => error instanceof LlmError && ['MALFORMED_RESPONSE', 'EMPTY_RESPONSE'].includes(error.code)); }
    finally { await ctx.stop(); }
  }
  const { ctx } = await context(async () => Response.json({ choices: [{ message: { content: 'partial' }, finish_reason: null }] }));
  try { await assert.rejects(ctx.llm.generate(request), errorCode('MALFORMED_RESPONSE')); }
  finally { await ctx.stop(); }
});

test('取消、超时和插件卸载中止在途 fetch 并禁止后续调用', async () => {
  const { ctx, provider } = await context(async (_url, options) => new Promise((_resolve, reject) => {
    const fail = () => reject(options!.signal!.reason);
    options!.signal!.addEventListener('abort', fail, { once: true });
    if (options!.signal!.aborted) fail();
  }));
  try {
    await assert.rejects(ctx.llm.generate(request, { timeoutMs: 5 }), errorCode('TIMEOUT'));
    const controller = new AbortController();
    const aborted = ctx.llm.generate(request, { signal: controller.signal }); controller.abort();
    await assert.rejects(aborted, errorCode('ABORTED'));
    const pending = ctx.llm.generate(request);
    const rejection = assert.rejects(pending, errorCode('ABORTED'));
    await provider.dispose(); await rejection;
    assert.equal(ctx.llm.activeRequestCount, 0);
    await assert.rejects(ctx.llm.generate(request), errorCode('NO_ADAPTER'));
    const service = ctx.llm; await ctx.stop();
    await assert.rejects(service.generate(request), errorCode('CLOSED'));
  } finally { await ctx.stop(); }
});

test('消费者提前退出 SSE 会取消响应体', async () => {
  let canceled = false;
  const { ctx } = await context(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"},"finish_reason":null}]}\n\n')); }, cancel() { canceled = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
  try { for await (const _chunk of ctx.llm.stream(request)) break; assert.equal(canceled, true); assert.equal(ctx.llm.activeRequestCount, 0); }
  finally { await ctx.stop(); }
});

test('真实本地 HTTP 服务验证 API 路由和请求序列化', async () => {
  const server: Server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { assert.equal(req.url, '/v1/chat/completions'); assert.equal(JSON.parse(body).model, 'model'); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response)); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const ctx = new Context(); ctx.plugin(llmPlugin); ctx.plugin(openAiCompatiblePlugin, { id: 'test', baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'mock-key' });
  await ctx.start();
  try { assert.equal((await ctx.llm.generate(request)).text, '你好'); }
  finally { await ctx.stop(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
