export type { CompanyOptions } from '../cordis/config.js';
import type { AgentFeedback, AgentRunSnapshot, JsonObject } from '../agents-dag-context/types.js';
import type { StudioSnapshot } from '../pixel-studio/types.js';
export type CompanyStatus = 'PLANNING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export interface CompanyTaskInput { readonly objective: string; readonly context?: JsonObject }
/** 浏览器可读取的任务快照；不主动暴露宿主配置或转发 CLI 原始事件。 */
export interface CompanySnapshot {
  readonly runId: string;
  readonly objective: string;
  readonly status: CompanyStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string;
  readonly run?: AgentRunSnapshot;
  readonly feedback: Readonly<Record<string, AgentFeedback>>;
  readonly studio: StudioSnapshot;
}

export interface CompanyClientState {
  readonly connected: boolean;
  readonly tasks: readonly CompanySnapshot[];
  readonly selectedRunId: string | null;
  readonly current: CompanySnapshot | null;
  readonly error: string;
}
