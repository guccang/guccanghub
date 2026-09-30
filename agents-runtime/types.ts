export type { AgentsRuntimeOptions } from '../cordis/config.js';
export type { RuntimeAgentProfile } from '../cordis/config.js';
import type { AgentExecutionInput } from '../agents-dag-context/types.js';
export const runtimeHostTypes = ['codex', 'claudecode', 'deepseek-harness', 'opencode'] as const;
export type RuntimeHostType = typeof runtimeHostTypes[number];

export interface RuntimeTask {
  readonly id: string;
  readonly agentId: string;
  readonly input: string;
  readonly images?: readonly string[];
  /** 显式续接；不会自动把不同节点或尝试合并为会话。 */
  readonly sessionId?: string;
}
export interface RuntimeRunOptions {
  readonly signal?: AbortSignal;
  /** 0 表示不设超时。 */
  readonly timeoutMs?: number;
}
export interface RuntimeResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly error: string;
  readonly sessionId: string;
  readonly finalMessage: string;
  readonly stopped: boolean;
}
export interface RuntimeTaskHandle {
  readonly id: string;
  readonly done: Promise<RuntimeResult>;
  stop(): void;
}
export interface RuntimeEvent {
  readonly taskId: string;
  readonly agentId: string;
  readonly type: string;
  /** 原生事件可能包含诊断或工具输出，仅用于服务端。 */
  readonly text: string;
}
export interface RuntimeSessionEvent {
  readonly taskId: string;
  readonly agentId: string;
  readonly sessionId: string;
}
export interface ProcessResult {
  readonly code: number | null;
  readonly signal?: string | null;
  readonly error?: string;
}
export interface ProcessHandle {
  readonly done: Promise<ProcessResult>;
  stop(): void;
  /** DeepSeek ACP 执行器需要支持持续输入。 */
  write?(value: string): void;
  endInput?(): void;
}
export interface ProcessOptions {
  readonly cwd: string;
  readonly input?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly keepInputOpen?: boolean;
  readonly onLine?: (kind: 'stdout' | 'stderr', line: string) => void;
}
export type RuntimeProcessExecutor = (command: string, args: string[], options: ProcessOptions) => ProcessHandle;

export interface RuntimeDagOptions extends RuntimeRunOptions {
  readonly sessionId?: string;
  readonly images?: readonly string[];
}
export type RuntimeDagRequest = AgentExecutionInput;
