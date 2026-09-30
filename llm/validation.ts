import { assertJson, assertJsonObject } from '../agents-dag-context/validation.js';
import { LlmError } from './error.js';
import type { LlmRequest } from './types.js';
export function validateRequest(request: LlmRequest): void {
  const invalid = () => { throw new LlmError('INVALID_REQUEST', 'LLM 请求参数无效'); };
  if (!request || typeof request.provider !== 'string' || !request.provider.trim() || typeof request.model !== 'string' || !request.model.trim() || !Array.isArray(request.messages) || !request.messages.length) invalid();
  try { assertJson(request, 'llmRequest'); } catch { invalid(); }
  if (request.tools !== undefined && !Array.isArray(request.tools)) invalid();
  for (const message of request.messages) {
    if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role)) invalid();
    if (!(message.role === 'assistant' && message.content === null) && typeof message.content !== 'string') invalid();
    if (message.role === 'tool' && (typeof message.toolCallId !== 'string' || !message.toolCallId)) invalid();
    if (message.role === 'assistant') {
      if (message.reasoning !== undefined && typeof message.reasoning !== 'string') invalid();
      if (message.toolCalls !== undefined && !Array.isArray(message.toolCalls)) invalid();
      for (const call of message.toolCalls ?? []) if (!call || typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.name || typeof call.arguments !== 'string') invalid();
    }
  }
  if (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) invalid();
  if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0)) invalid();
  if (request.responseFormat !== undefined && !['text','json_object'].includes(request.responseFormat)) invalid();
  if (request.reasoningEffort !== undefined && (typeof request.reasoningEffort !== 'string' || !request.reasoningEffort.trim())) invalid();
  const names = new Set<string>();
  for (const tool of request.tools ?? []) {
    if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name) || names.has(tool.name)) invalid();
    if (tool.description !== undefined && typeof tool.description !== 'string') invalid();
    names.add(tool.name);
    try { assertJsonObject(tool.parameters, "tool.parameters"); } catch { invalid(); }
  }
}
export function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new LlmError('INVALID_REQUEST', 'timeoutMs 必须为 0 到 2147483647 的整数');
  return value;
}
