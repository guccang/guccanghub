// 上游当前发布纯 JavaScript；本地桥接限定实际使用的接口。
// @ts-expect-error @guccang/agents-runtime 尚未提供 TypeScript 声明。
import { runHost, hostEnvironment } from '@guccang/agents-runtime';
import type { ProcessHandle, RuntimeHostType, RuntimeProcessExecutor } from './types.js';
interface HostResult {
  code: number | null;
  signal?: string | null;
  error?: string;
  sessionId?: string;
  finalMessage?: string;
}
export interface HostOptions {
  hostType: RuntimeHostType;
  cwd: string;
  input: string;
  images: string[];
  sessionId: string;
  model: string;
  reasoningEffort: string;
  env: NodeJS.ProcessEnv;
  execute?: RuntimeProcessExecutor;
  onEvent(type: string, text: string): void;
  onSession(id: string): void;
}
export const invokeHost: (options: HostOptions) => Omit<ProcessHandle, 'done'> & { done: Promise<HostResult> } = runHost;
export const runtimeEnvironment: (dataDir: string, type: RuntimeHostType, parent: NodeJS.ProcessEnv, model: string) => NodeJS.ProcessEnv = hostEnvironment;
