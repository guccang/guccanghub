/** Agent 上下文模块使用的 JSON 值。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

/** 输入、输出及边数据均使用 JSON 对象。 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** 用户目标及进入规划器的初始上下文。 */
export interface AgentGoal {
  readonly objective: string;
  readonly context: JsonObject;
}

/** 规划器对单个 DAG 节点给出的 Agent 与输入。 */
export interface PlannedAgentNode {
  readonly agentId: string;
  readonly instruction: string;
  readonly input: JsonObject;
}

/** 节点上持久保存的上下文文件夹引用。 */
export interface NodeContextRef {
  readonly relativeDir: string;
}

/** 已挂载上下文引用的 DAG 节点数据。 */
export interface AgentNodeData {
  readonly agentId: string;
  readonly instruction: string;
  readonly contextRef: NodeContextRef;
}

/** Agent 执行成功时必须返回的固定 JSON 格式。 */
export interface AgentSuccessFeedback {
  readonly status: "SUCCEEDED";
  readonly summary: string;
  readonly output: JsonObject;
}

/** Agent 执行失败时必须返回的固定 JSON 格式。 */
export interface AgentFailureFeedback {
  readonly status: "FAILED";
  readonly summary: string;
  readonly output: JsonObject;
  readonly error: string;
}

/** Agent 执行反馈，所有分支均包含结构化输出。 */
export type AgentFeedback = AgentSuccessFeedback | AgentFailureFeedback;

/** 节点持久化状态。UNKNOWN 表示重启后无法确认外部执行结果。 */
export type AgentNodeStatus =
  | "READY"
  | "BLOCKED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "PAUSED"
  | "UNKNOWN";

/** 一次状态变化的持久化记录。 */
export interface AgentStateChange {
  readonly status: AgentNodeStatus;
  readonly at: string;
  readonly reason?: string;
}

/** 节点当前状态及全部状态变化。 */
export interface AgentNodeState {
  readonly nodeId: string;
  readonly status: AgentNodeStatus;
  readonly attempt: number;
  readonly updatedAt: string;
  readonly reason?: string;
  readonly history: readonly AgentStateChange[];
}

/** 规划器端口，由宿主负责实现真实 LLM 调用。 */
export interface AgentPlannerPort {
  decompose(request: {
    readonly runId: string;
    readonly goal: AgentGoal;
  }): Promise<import("../dag/types.js").Dag<PlannedAgentNode, JsonObject>>;
}

/** 提交给 Agent 执行器的冻结 JSON 输入。 */
export interface AgentExecutionInput {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly agentId: string;
  readonly instruction: string;
  readonly goal: AgentGoal;
  readonly input: JsonObject;
  readonly dependencies: readonly {
    readonly edgeId: string;
    readonly source: string;
    readonly relation: JsonObject;
    readonly output: JsonObject;
  }[];
}

/** 执行器端口；返回值在持久化前按固定反馈协议校验。 */
export interface AgentExecutorPort {
  execute(request: AgentExecutionInput): Promise<unknown>;
}

/** 一个目标的持久化计划。 */
export interface AgentRunPlan {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly goal: AgentGoal;
  readonly graph: import("../dag/types.js").Dag<AgentNodeData, JsonObject>;
  readonly createdAt: string;
}

/** 读取目标时得到的图与节点状态。 */
export interface AgentRunSnapshot extends AgentRunPlan {
  readonly states: Readonly<Record<string, AgentNodeState>>;
}

/** 读取节点文件夹时返回的数据。 */
export interface AgentNodeContext {
  readonly node: import("../dag/types.js").DagNode<AgentNodeData>;
  readonly input: JsonObject;
  readonly state: AgentNodeState;
  readonly feedback?: AgentFeedback;
  readonly output?: JsonObject;
}
