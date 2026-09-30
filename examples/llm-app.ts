/** 默认模拟 HTTP API；--live 才使用真实 API Key 和网络。 */
import { Context } from 'cordis';
import { llmPlugin, openAiCompatiblePlugin, type LlmRequest } from '@goalsplit/dag/llm';
import { llmConfigFromEnv } from '@goalsplit/dag/cordis/config.node';
const live = process.argv.includes('--live');
const config = live ? llmConfigFromEnv() : { provider: { id: 'api', baseURL: 'https://mock.example/v1', apiKey: 'mock-key' }, model: 'mock-model' };
const mockFetch: typeof fetch = async (_url, init) => {
  const request = JSON.parse(String(init?.body));
  const result = { choices: [{ index: 0, message: { role: 'assistant', content: 'LLM API 与 Cordis 已连通。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } };
  if (!request.stream) return Response.json(result);
  return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'LLM API 与 Cordis 已连通。' }, finish_reason: 'stop' }], usage: result.usage })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};
const ctx = new Context();
ctx.plugin(llmPlugin, { timeoutMs: 'timeoutMs' in config ? config.timeoutMs : undefined });
ctx.plugin(openAiCompatiblePlugin, {
  ...config.provider,
  ...(!live ? { fetch: mockFetch } : {}),
});
await ctx.start();
try {
  const request: LlmRequest = { provider: 'api', model: config.model, messages: [{ role: 'user', content: '用一句话介绍 API 调用的作用。' }] };
  console.log(JSON.stringify({ mode: live ? 'live' : 'simulated', response: await ctx.llm.generate(request) }, null, 2));
  for await (const chunk of ctx.llm.stream(request)) console.log(JSON.stringify(chunk));
} finally { await ctx.stop(); }
