import { serviceDefaults } from '../cordis/config.js';
import { Service, type Context } from 'cordis';
import { LlmError } from './error.js';
import { freeze } from '../cordis/utils.js';
import { validateRequest, validateTimeout } from './validation.js';
import type { LlmAdapter, LlmCallOptions, LlmChunk, LlmFinishReason, LlmRequest, LlmResponse, LlmServiceOptions, LlmUsage } from './types.js';
declare module 'cordis' { interface Context { llm: LlmService } }
export class LlmService extends Service {
  private readonly adapters = new Map<string, LlmAdapter>();
  private readonly active = new Map<AbortController, string>();
  private readonly timeoutMs: number;
  private closed = false;
  constructor(ctx: Context, options: LlmServiceOptions = {}) {
    const timeoutMs = validateTimeout(options.timeoutMs ?? serviceDefaults.llm.timeoutMs);
    super(ctx, 'llm'); this.timeoutMs = timeoutMs;
    ctx.on('dispose', () => this.shutdown());
  }
  get activeRequestCount(): number { return this.active.size; }
  listProviders(): readonly { id: string; models: readonly string[] }[] { return [...this.adapters.entries()].map(([id, adapter]) => ({ id, models: [...(adapter.models ?? [])] })); }
  registerAdapter(adapter: LlmAdapter): () => void {
    if (this.closed) throw new LlmError('CLOSED', 'LLM 服务已关闭');
    if (!adapter.id?.trim() || typeof adapter.stream !== 'function') throw new LlmError('INVALID_REQUEST', 'LLM 适配器无效');
    if (this.adapters.has(adapter.id)) throw new LlmError('INVALID_REQUEST', 'LLM 提供方 ID 已注册');
    const id = adapter.id;
    this.adapters.set(id, adapter);
    return () => {
      if (this.adapters.get(id) !== adapter) return;
      this.adapters.delete(id);
      for (const [controller, provider] of this.active) if (provider === id) controller.abort(new LlmError('ABORTED', 'LLM 提供方已卸载'));
    };
  }
  shutdown(): void {
    this.closed = true;
    for (const controller of this.active.keys()) controller.abort(new LlmError('ABORTED', 'LLM 服务已卸载'));
    this.active.clear(); this.adapters.clear();
  }
  private async *call(request: LlmRequest, options: LlmCallOptions, streaming: boolean): AsyncGenerator<LlmChunk> {
    if (this.closed) throw new LlmError('CLOSED', 'LLM 服务已关闭');
    validateRequest(request);
    const adapter = this.adapters.get(request.provider);
    if (!adapter) throw new LlmError('NO_ADAPTER', '未注册请求的 LLM 提供方');
    const timeoutMs = validateTimeout(options.timeoutMs ?? this.timeoutMs);
    const copy = freeze(structuredClone(request));
    const controller = new AbortController();
    const abort = () => controller.abort(new LlmError('ABORTED', 'LLM 调用已取消'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = timeoutMs ? setTimeout(() => controller.abort(new LlmError('TIMEOUT', 'LLM 调用超时')), timeoutMs) : undefined;
    const cleanupAbort = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    controller.signal.addEventListener('abort', cleanupAbort, { once: true });
    if (controller.signal.aborted) cleanupAbort();
    this.active.set(controller, request.provider);
    let finished = false, content = false;
    try {
      controller.signal.throwIfAborted();
      for await (const chunk of adapter.stream(copy, { signal: controller.signal, streaming })) {
        controller.signal.throwIfAborted();
        if (finished) throw new LlmError('MALFORMED_RESPONSE', 'LLM 结束后仍产生分片');
        if (chunk.type === 'finish') {
          if (!content) throw new LlmError('EMPTY_RESPONSE', 'LLM 未返回文本或工具调用');
          finished = true;
        } else if (chunk.type === 'tool-call' || (chunk.type === 'text' || chunk.type === 'reasoning') && !!chunk.text) content = true;
        yield chunk;
      }
      controller.signal.throwIfAborted();
      if (!finished) throw new LlmError('MALFORMED_RESPONSE', 'LLM 适配器缺少结束分片');
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof LlmError) throw error;
      throw new LlmError('NETWORK', 'LLM 传输失败');
    } finally {
      cleanupAbort();
      controller.signal.removeEventListener('abort', cleanupAbort);
      controller.abort();
      this.active.delete(controller);
    }
  }
  stream(request: LlmRequest, options: LlmCallOptions = {}): AsyncIterable<LlmChunk> { return this.call(request, options, true); }
  async generate(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    let text = '', reasoning = '', finishReason: LlmFinishReason | undefined, usage: LlmUsage | undefined;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const chunk of this.call(request, options, false)) {
      if (chunk.type === 'text') text += chunk.text;
      else if (chunk.type === 'reasoning') reasoning += chunk.text;
      else if (chunk.type === 'usage') usage = chunk.usage;
      else if (chunk.type === 'finish') finishReason = chunk.reason;
      else {
        const call = calls.get(chunk.index) ?? { id: '', name: '', arguments: '' };
        if (chunk.id !== undefined) call.id = chunk.id;
        if (chunk.name !== undefined) call.name += chunk.name;
        call.arguments += chunk.arguments;
        calls.set(chunk.index, call);
      }
    }
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (toolCalls.some(call => !call.id || !call.name)) throw new LlmError('MALFORMED_RESPONSE', 'LLM 工具调用缺少标识或名称');
    return freeze({ text, reasoning, toolCalls, finishReason: finishReason!, ...(usage ? { usage } : {}) });
  }
}
export const llmPlugin = {
  name: 'llm', provide: 'llm',
  apply(ctx: Context, options: LlmServiceOptions = {}) { return new LlmService(ctx, options); },
};
