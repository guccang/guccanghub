export type LlmErrorCode = 'NO_ADAPTER' | 'INVALID_REQUEST' | 'MISSING_CREDENTIAL' | 'INVALID_CREDENTIAL' | 'AUTH' | 'QUOTA' | 'RATE_LIMIT' | 'SERVER' | 'HTTP' | 'NETWORK' | 'TIMEOUT' | 'ABORTED' | 'MALFORMED_RESPONSE' | 'EMPTY_RESPONSE' | 'CLOSED';
export class LlmError extends Error {
  constructor(readonly code: LlmErrorCode, message: string, readonly status?: number, readonly retryAfterMs?: number, readonly requestId?: string) {
    super(message); this.name = 'LlmError';
  }
}
/** 不保留提供方原始错误正文或网络错误，避免泄露凭据和请求内容。 */
export function httpError(response: Response): LlmError {
  const status = response.status;
  const code: LlmErrorCode = status === 401 || status === 403 ? 'AUTH' : status === 402 ? 'QUOTA' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : status === 400 || status === 413 ? 'INVALID_REQUEST' : 'HTTP';
  const retry = response.headers.get('retry-after');
  const delay = retry === null ? NaN : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
  return new LlmError(code, `LLM API 请求失败 (HTTP ${status})`, status, Number.isFinite(delay) && delay > 0 ? delay : undefined, response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined);
}
