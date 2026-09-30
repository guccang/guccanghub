import { LlmError } from './error.js';
/** 按完整 SSE 帧解析，保留 UTF-8 分片、CR/LF 和多行 data，不接收未终止尾帧。 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data: string[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      signal.throwIfAborted();
      buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
      if (buffer.length > 2 * 1024 * 1024) throw new LlmError('MALFORMED_RESPONSE', 'SSE 帧超过大小限制');
      let position: number;
      while ((position = buffer.search(/[\r\n]/)) >= 0) {
        if (buffer[position] === '\r' && position === buffer.length - 1 && !result.done) break;
        const line = buffer.slice(0, position);
        const separator = buffer[position] === '\r' && buffer[position + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(position + separator);
        if (!line) { if (data.length) { yield data.join('\n'); data = []; } }
        else if (line === 'data' || line.startsWith('data:')) {
          const value = line === 'data' ? '' : line.slice(5).replace(/^ /, '');
          data.push(value);
          if (data.reduce((sum, value) => sum + value.length, 0) > 2 * 1024 * 1024) throw new LlmError('MALFORMED_RESPONSE', 'SSE 帧超过大小限制');
        }
      }
      if (result.done) break;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
