export type { OpenAiCompatibleOptions } from '../cordis/config.js';
export type { LlmServiceOptions } from '../cordis/config.js';
import type { JsonObject } from '../agents-dag-context/types.js';
export interface LlmToolCall { readonly id: string; readonly name: string; readonly arguments: string }
export type LlmMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string | null; readonly reasoning?: string; readonly toolCalls?: readonly LlmToolCall[] }
  | { readonly role: 'tool'; readonly content: string; readonly toolCallId: string };
export interface LlmTool { readonly name: string; readonly description?: string; readonly parameters: JsonObject }
export interface LlmRequest {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly tools?: readonly LlmTool[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFormat?: 'text' | 'json_object';
  readonly reasoningEffort?: string;
}
export interface LlmUsage {
  /** 输入总数包含缓存命中，不与 cacheReadTokens 重复相加。 */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens?: number;
}
export type LlmFinishReason = 'stop' | 'tool-calls' | 'max-tokens';
export type LlmChunk =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly index: number; readonly id?: string; readonly name?: string; readonly arguments: string }
  | { readonly type: 'usage'; readonly usage: LlmUsage }
  | { readonly type: 'finish'; readonly reason: LlmFinishReason };
export interface LlmResponse {
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: readonly LlmToolCall[];
  readonly finishReason: LlmFinishReason;
  readonly usage?: LlmUsage;
}
export interface LlmCallOptions { readonly signal?: AbortSignal; readonly timeoutMs?: number }
export interface LlmAdapterContext { readonly signal: AbortSignal; readonly streaming: boolean }
/** 提供方把自己的协议翻译为公共词汇；不执行工具或管理任务。 */
export interface LlmAdapter {
  readonly id: string;
  readonly models?: readonly string[];
  stream(request: LlmRequest, context: LlmAdapterContext): AsyncIterable<LlmChunk>;
}
