import type { DeepseekLlmOptions } from '../cordis/config.js';
import { serviceDefaults } from '../cordis/config.js';
import type { Context } from 'cordis';
import { LlmError, httpError } from './error.js';
import { readSse } from './sse.js';
import type { LlmAdapter, LlmAdapterContext, LlmChunk, LlmFinishReason, LlmRequest, OpenAiCompatibleOptions } from './types.js';
import './service.js';
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LlmError('MALFORMED_RESPONSE', 'LLM 响应结构无效');
  return value as RecordValue;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new LlmError('MALFORMED_RESPONSE', 'LLM token 用量无效');
  return value as number;
}
function finish(value: unknown): LlmFinishReason {
  if (value === 'stop') return 'stop';
  if (value === 'tool_calls') return 'tool-calls';
  if (value === 'length') return 'max-tokens';
  throw new LlmError('MALFORMED_RESPONSE', 'LLM 返回未知结束原因');
}
/** 独立 wire-format 翻译，覆盖可见文本、推理、工具调用和总用量。 */
function* translate(raw: unknown, streaming: boolean): Generator<LlmChunk> {
  const value = object(raw);
  if (value.error) throw new LlmError('SERVER', 'LLM 流返回供应商错误');
  if (!Array.isArray(value.choices) || value.choices.length > 1) throw new LlmError('MALFORMED_RESPONSE', 'LLM 必须返回单个候选响应');
  if (value.choices.length) {
    const choice = object(value.choices[0]);
    const message = object(streaming ? choice.delta : choice.message);
    for (const [key, type] of [['content', 'text'], ['reasoning_content', 'reasoning']] as const) {
      if (message[key] != null) {
        if (typeof message[key] !== 'string') throw new LlmError('MALFORMED_RESPONSE', 'LLM 文本分片无效');
        if (message[key]) yield { type, text: message[key] as string };
      }
    }
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) throw new LlmError('MALFORMED_RESPONSE', 'LLM 工具调用无效');
      for (const [position, item] of message.tool_calls.entries()) {
        const call = object(item), fn = object(call.function);
        const index = streaming ? count(call.index) : position;
        if (call.id !== undefined && typeof call.id !== 'string' || fn.name !== undefined && typeof fn.name !== 'string' || fn.arguments !== undefined && typeof fn.arguments !== 'string') throw new LlmError('MALFORMED_RESPONSE', 'LLM 工具调用分片无效');
        yield { type: 'tool-call', index, ...(call.id !== undefined ? { id: call.id as string } : {}), ...(fn.name !== undefined ? { name: fn.name as string } : {}), arguments: (fn.arguments as string | undefined) ?? '' };
      }
    }
    if (choice.finish_reason != null) yield { type: 'finish', reason: finish(choice.finish_reason) };
  }
  if (value.usage != null) {
    const usage = object(value.usage);
    const details = usage.prompt_tokens_details == null ? {} : object(usage.prompt_tokens_details);
    const cached = usage.prompt_cache_hit_tokens ?? details.cached_tokens;
    yield { type: 'usage', usage: { inputTokens: count(usage.prompt_tokens), outputTokens: count(usage.completion_tokens), totalTokens: count(usage.total_tokens), ...(cached === undefined ? {} : { cacheReadTokens: count(cached) }) } };
  }
}

export class OpenAiCompatibleAdapter implements LlmAdapter {
  readonly id: string;
  readonly models: readonly string[];
  private readonly options: OpenAiCompatibleOptions;
  private readonly endpoint: string;
  constructor(options: OpenAiCompatibleOptions) {
    if (!options.id?.trim()) throw new LlmError('INVALID_REQUEST', '提供方 ID 不能为空');
    let url: URL;
    try { url = new URL(options.baseURL); } catch { throw new LlmError('INVALID_REQUEST', 'baseURL 无效'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new LlmError('INVALID_REQUEST', 'baseURL 必须为不含凭据或查询参数的 HTTP(S) API 根路径');
    this.id = options.id;
    this.models = Object.freeze([...(options.models ?? [])]);
    this.options = { ...options };
    this.endpoint = options.baseURL.replace(/\/+$/, '') + '/chat/completions';
  }
  async *stream(request: LlmRequest, context: LlmAdapterContext): AsyncGenerator<LlmChunk> {
    const supplied = typeof this.options.apiKey === 'function' ? await this.options.apiKey() : this.options.apiKey;
    if (typeof supplied !== 'string' || !supplied.trim()) throw new LlmError('MISSING_CREDENTIAL', '未配置 LLM API Key');
    const key = supplied.trim();
    if (!/^[\x21-\x7e]+$/.test(key)) throw new LlmError('INVALID_CREDENTIAL', 'LLM API Key 格式无效');
    context.signal.throwIfAborted();
    const body = {
      model: request.model,
      messages: request.messages.map(message => {
        if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
        if (message.role === 'assistant') return { role: 'assistant', content: message.content, ...(message.reasoning !== undefined ? { reasoning_content: message.reasoning } : {}), ...(message.toolCalls ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) };
        return { role: message.role, content: message.content };
      }),
      stream: context.streaming,
      ...(context.streaming ? { stream_options: { include_usage: true } } : {}),
      ...(request.tools ? { tools: request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.reasoningEffort !== undefined ? { reasoning_effort: request.reasoningEffort } : {}),
      ...(request.responseFormat ? { response_format: { type: request.responseFormat } } : {}),
    };
    const response = await (this.options.fetch ?? globalThis.fetch)(this.endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: context.signal });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw httpError(response); }
    if (!context.streaming) {
      let value: unknown;
      try { value = await response.json(); } catch { context.signal.throwIfAborted(); throw new LlmError('MALFORMED_RESPONSE', 'LLM API 返回无效 JSON'); }
      let reason: LlmFinishReason | undefined;
      for (const chunk of translate(value, false)) { if (chunk.type === 'finish') reason = chunk.reason; else yield chunk; }
      if (!reason) throw new LlmError('MALFORMED_RESPONSE', 'LLM 响应缺少结束原因');
      yield { type: 'finish', reason }; return;
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel().catch(() => {});
      throw new LlmError('MALFORMED_RESPONSE', 'LLM API 未返回 SSE 流');
    }
    let reason: LlmFinishReason | undefined, ended = false;
    for await (const frame of readSse(response.body, context.signal)) {
      if (frame === '[DONE]') { ended = true; break; }
      let raw: unknown;
      try { raw = JSON.parse(frame); } catch { throw new LlmError('MALFORMED_RESPONSE', 'SSE 分片不是有效 JSON'); }
      for (const chunk of translate(raw, true)) {
        if (chunk.type === 'finish') {
          if (reason) throw new LlmError('MALFORMED_RESPONSE', 'LLM 重复返回结束原因');
          reason = chunk.reason;
        } else {
          if (reason && chunk.type !== 'usage') throw new LlmError('MALFORMED_RESPONSE', 'LLM 在结束后仍返回内容');
          yield chunk;
        }
      }
    }
    if (!ended || !reason) throw new LlmError('MALFORMED_RESPONSE', 'LLM 流中断，缺少完整结束标记');
    yield { type: 'finish', reason };
  }
}
export const openAiCompatiblePlugin = {
  name: 'llm-openai-compatible', reusable: true, inject: ['llm'],
  apply(ctx: Context, options: OpenAiCompatibleOptions) {
    const dispose = ctx.llm.registerAdapter(new OpenAiCompatibleAdapter(options));
    ctx.on('dispose', dispose);
  },
};
export const deepseekLlmPlugin = {
  name: 'llm-deepseek-api', reusable: true, inject: ['llm'],
  apply(ctx: Context, options: DeepseekLlmOptions) {
    openAiCompatiblePlugin.apply(ctx, { ...options, baseURL: options.baseURL ?? serviceDefaults.llm.deepseekBaseURL });
  },
};
