/** 运行时公共协议：任务、图、执行记录与宿主扩展端口。 */
import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema),
]));
export const taskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/), revision: z.number().int().positive().default(1),
  title: z.string().min(1), description: z.string().default(''), executor: z.string().min(1),
  dependencies: z.array(z.string()).default([]), context: z.record(z.string(), jsonSchema).default({}),
  contextRefs: z.array(z.object({ taskId: z.string(), output: z.string() })).default([]),
  outputs: z.array(z.string().min(1)).default([]), resources: z.array(z.string().min(1)).default([]),
  required: z.boolean().default(true),
}).strict();
export type TaskSpec = z.infer<typeof taskSchema>;
export const graphSchema = z.object({ tasks: z.array(taskSchema).min(1).max(1000) }).strict();
export type Graph = z.infer<typeof graphSchema>;
export const goalSchema = z.object({
  objective: z.string().min(1), constraints: z.array(z.string()).default([]), acceptance: z.array(z.string()).default([]),
}).strict();
export type Goal = z.infer<typeof goalSchema>;
export type RunStatus = 'CREATED' | 'PLANNING' | 'RUNNING' | 'EVALUATING' | 'PAUSING' | 'PAUSED' | 'WAITING_INPUT' | 'RECOVERING' | 'SUCCEEDED' | 'FAILED';
export type TaskStatus = 'PENDING' | 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED' | 'UNKNOWN';
export interface PlanVersion { version: number; parentVersion: number | null; graph: Graph; reason: string; evidenceRefs: string[]; createdAt: string }
export interface Artifact { id: string; runId: string; attemptId: string; name: string; hash: string; size: number; mediaType: string; createdAt: string }
export interface TaskRun {
  taskId: string; generation: number; specRevision: number; status: TaskStatus; valid: boolean;
  blockedReason?: string; output?: Record<string, Json>; artifactIds: string[]; attemptIds: string[];
}
export interface FrozenContext {
  goal: Goal; task: TaskSpec;
  userInputs: { text: string; createdAt: string }[];
  dependencies: Record<string, { generation: number; specRevision: number; attemptId: string; output: Record<string, Json>; artifactIds: string[] }>;
}
export interface Attempt {
  id: string; runId: string; taskId: string; generation: number; planVersion: number;
  executor: string; status: 'DISPATCHED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED' | 'UNKNOWN';
  input: FrozenContext; startedAt: string; endedAt?: string; externalHandle?: Json;
  checkpoint?: Json; resumedFrom?: string; progress?: { message: string; percent?: number };
  result?: ExecutionResult; error?: string;
}
export interface RuntimeEvent { runId: string; seq: number; type: string; at: string; data: Json; stateRevision: number }
export interface Policy { maxConcurrentTasks: number; maxReplans: number; noProgressLimit: number; plannerTimeoutMs: number }
export interface RunSnapshot {
  id: string; goal: Goal; status: RunStatus; createdAt: string; updatedAt: string;
  stateRevision: number; lastEventSeq: number; planVersion: number;
  plans: PlanVersion[]; tasks: TaskRun[]; attempts: Attempt[]; artifacts: Artifact[];
  needsEvaluation: boolean; trigger: string; replanCount: number; noProgressCount: number;
  policy: Policy; reason?: string; pendingReruns: string[]; resumeAfterDrain: boolean;
  layout: Record<string, { x: number; y: number }>; parentRunId?: string;
  userInputs: { text: string; createdAt: string }[];
}
export const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('addTask'), task: taskSchema }).strict(),
  z.object({ type: z.literal('updateTask'), taskId: z.string(), changes: taskSchema.omit({ id: true, revision: true }).partial() }).strict(),
  z.object({ type: z.literal('removeTask'), taskId: z.string() }).strict(),
  z.object({ type: z.literal('addDependency'), taskId: z.string(), dependencyId: z.string() }).strict(),
  z.object({ type: z.literal('removeDependency'), taskId: z.string(), dependencyId: z.string() }).strict(),
]);
export const proposalSchema = z.object({
  basePlanVersion: z.number().int().nonnegative(), baseStateRevision: z.number().int().nonnegative(),
  operations: z.array(operationSchema), reason: z.string().min(1), evidenceRefs: z.array(z.string()).default([]),
}).strict();
export type PlanProposal = z.infer<typeof proposalSchema>;
export const decisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('REVISE'), proposal: proposalSchema }).strict(),
  z.object({ type: z.literal('CONTINUE'), reason: z.string() }).strict(),
  z.object({ type: z.literal('WAIT'), reason: z.string().min(1) }).strict(),
  z.object({ type: z.literal('COMPLETE'), reason: z.string().min(1), evidenceRefs: z.array(z.string()).min(1) }).strict(),
]);
export type PlanDecision = z.infer<typeof decisionSchema>;
export const resultSchema = z.object({
  status: z.enum(['SUCCEEDED', 'FAILED', 'INTERRUPTED']),
  output: z.record(z.string(), jsonSchema).default({}), artifactIds: z.array(z.string()).default([]), error: z.string().optional(),
}).strict();
export type ExecutionResult = z.infer<typeof resultSchema>;
export interface PlannerPort {
  /** 根据冻结快照提出决策；宿主自行实现模型或规则逻辑。 */
  evaluate(snapshot: RunSnapshot, trigger: string, signal: AbortSignal): Promise<PlanDecision>;
}
export interface ExecutionRequest { attemptId: string; runId: string; taskId: string; generation: number; input: FrozenContext; checkpoint?: Json }
export interface ExecutionContext {
  signal: AbortSignal;
  /** 保存可观察进度，不得据此判定任务成功。 */
  reportProgress(message: string, percent?: number): void;
  /** 保存宿主的外部执行句柄。 */
  saveHandle(handle: Json): void;
  /** 保存由执行器解释的不透明检查点。 */
  saveCheckpoint(checkpoint: Json): void;
  /** 将产物持久化后返回稳定引用。 */
  saveArtifact(name: string, content: string | Uint8Array, mediaType?: string): Artifact;
}
export type RecoveryResult =
  | { status: 'COMPLETED'; result: ExecutionResult }
  | { status: 'RUNNING'; observe: (context: ExecutionContext) => Promise<ExecutionResult> }
  | { status: 'UNKNOWN'; reason: string };
export interface ExecutorPort {
  capabilities?: { interrupt?: boolean; checkpoint?: boolean; idempotent?: boolean; resourceIsolation?: boolean };
  /** 执行一次任务；attemptId 是宿主应使用的幂等键。 */
  execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult>;
  /** 核对执行是否已发生；不得在此方法中盲目重新执行。 */
  reconcile(attempt: Attempt): Promise<RecoveryResult>;
}
export interface StoreTransaction {
  state: RunSnapshot;
  /** 将事件与状态变更放入同一事务。 */
  emit(type: string, data?: Json): void;
}
export interface RuntimeStore {
  /** 获取或续持单个调度所有者的租约。 */
  acquire(owner: string, ttlMs: number): number;
  renew(owner: string, token: number, ttlMs: number): void;
  release(owner: string, token: number): void;
  create(state: RunSnapshot, fence: number, commandId: string, fingerprint: string): string;
  transact<T>(runId: string, fence: number, action: (tx: StoreTransaction) => T, command?: { id: string; fingerprint: string }): T;
  read(runId: string): RunSnapshot;
  readAt(runId: string, eventSeq: number): RunSnapshot;
  list(): RunSnapshot[];
  events(runId: string, after?: number, limit?: number): RuntimeEvent[];
  writeArtifact(runId: string, attemptId: string, name: string, content: string | Uint8Array, mediaType: string): Artifact;
  readArtifact(artifact: Artifact): Uint8Array;
  hasArtifact(artifact: Artifact): boolean;
  close(): void;
}
