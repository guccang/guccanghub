import { copyJson, freeze as freezeJson } from '../cordis/utils.js';
import type { AgentsDagContextOptions } from '../cordis/config.js';
export type { AgentsDagContextOptions } from '../cordis/config.js';
/** 目标拆解、Agent 执行及节点上下文的文件式协调层。 */
import {
  createDag,
  getNode,
  incomingEdges,
  topologicalOrder,
} from "../dag/index.js";
import { AgentContextFileStore } from "./store.js";
import {
  assertJsonObject,
  parseAgentFeedback,
  validateGoal,
  validatePlannedDag,
} from "./validation.js";
import type {
  AgentExecutionInput,
  AgentFeedback,
  AgentGoal,
  AgentNodeContext,
  AgentNodeState,
  AgentNodeStatus,
  AgentRunPlan,
  AgentRunSnapshot,
  JsonObject,
} from "./types.js";

/** 构造带一条初始历史的状态。 */
function initialState(
  nodeId: string,
  status: AgentNodeStatus,
  reason?: string,
): AgentNodeState {
  const at = new Date().toISOString();
  return {
    nodeId,
    status,
    attempt: 0,
    updatedAt: at,
    ...(reason ? { reason } : {}),
    history: [{ status, at, ...(reason ? { reason } : {}) }],
  };
}

/** 增加状态变化记录，保留前面的所有状态。 */
function nextState(
  current: AgentNodeState,
  status: AgentNodeStatus,
  reason?: string,
  attempt = current.attempt,
): AgentNodeState {
  const at = new Date().toISOString();
  return {
    nodeId: current.nodeId,
    status,
    attempt,
    updatedAt: at,
    ...(reason ? { reason } : {}),
    history: [
      ...current.history,
      { status, at, ...(reason ? { reason } : {}) },
    ],
  };
}

/** 将异常转换为可持久化的固定格式失败反馈。 */
function failureFeedback(error: unknown): AgentFeedback {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "FAILED",
    summary: "Agent 执行或反馈校验失败",
    output: {},
    error: message,
  };
}

/** 文件式 Agent DAG 上下文模块的配置。 */


/** 使用宿主提供的规划器、执行器与本地文件夹管理 DAG 节点上下文。 */
export class AgentsDagContext {
  readonly store: AgentContextFileStore;
  private readonly activeRuns = new Set<string>();

  /** 初始化模块，不调用外部 LLM。 */
  constructor(private readonly options: AgentsDagContextOptions) {
    this.store = new AgentContextFileStore(options.rootDir);
  }

  /** 将目标交给规划器拆解，并一次性发布 DAG、输入和初始状态文件。 */
  async decomposeGoal(
    runId: string,
    goal: AgentGoal,
  ): Promise<AgentRunSnapshot> {
    if (typeof runId !== "string" || !runId.trim())
      throw new Error("runId 必须是非空字符串");
    validateGoal(goal);
    const frozenGoal = freezeJson(copyJson(goal));
    const draft = validatePlannedDag(
      await this.options.planner.decompose({ runId, goal: frozenGoal }),
    );
    const graph = createDag({
      nodes: draft.nodes.map((node) => ({
        id: node.id,
        data: {
          agentId: node.data.agentId,
          instruction: node.data.instruction,
          contextRef: {
            relativeDir: this.store
              .nodeRelativeDir(node.id)
              .replaceAll("\\", "/"),
          },
        },
      })),
      edges: draft.edges.map((edge) => ({
        ...edge,
        data: copyJson(edge.data),
      })),
    });
    const inputs = Object.fromEntries(
      draft.nodes.map((node) => [node.id, copyJson(node.data.input)]),
    ) as Record<string, JsonObject>;
    const states = Object.fromEntries(
      graph.nodes.map((node) => {
        const incoming = incomingEdges(graph, node.id);
        return [
          node.id,
          initialState(
            node.id,
            incoming.length ? "BLOCKED" : "READY",
            incoming.length ? "等待上游节点成功" : undefined,
          ),
        ];
      }),
    ) as Record<string, AgentNodeState>;
    const plan: AgentRunPlan = {
      schemaVersion: 1,
      runId,
      goal: frozenGoal,
      graph,
      createdAt: new Date().toISOString(),
    };
    await this.store.createRun(plan, inputs, states);
    return { ...plan, states };
  }

  /** 从文件读取目标、图及每个节点的最新状态。 */
  async getSnapshot(runId: string): Promise<AgentRunSnapshot> {
    const plan = await this.loadPlan(runId);
    const pairs = await Promise.all(
      plan.graph.nodes.map(
        async (node) =>
          [node.id, await this.store.readState(runId, node.id)] as const,
      ),
    );
    return { ...plan, states: Object.fromEntries(pairs) };
  }

  /** 读取一个 DAG 节点挂载的规划输入、状态、反馈及输出。 */
  async getNodeContext(
    runId: string,
    nodeId: string,
  ): Promise<AgentNodeContext> {
    const plan = await this.loadPlan(runId);
    const node = getNode(plan.graph, nodeId);
    if (!node) throw new Error(`节点不存在: ${nodeId}`);
    const [input, state, feedback, output] = await Promise.all([
      this.store.readInput(runId, nodeId),
      this.store.readState(runId, nodeId),
      this.store.readFeedback(runId, nodeId),
      this.store.readOutput(runId, nodeId),
    ]);
    assertJsonObject(input, `${nodeId}.input`);
    if (output !== undefined) assertJsonObject(output, `${nodeId}.output`);
    return {
      node,
      input,
      state,
      ...(feedback ? { feedback: parseAgentFeedback(feedback) } : {}),
      ...(output ? { output } : {}),
    };
  }

  /** 在节点开始执行前替换其输入 JSON；已执行节点的冻结输入不允许覆盖。 */
  async updateNodeInput(
    runId: string,
    nodeId: string,
    input: JsonObject,
  ): Promise<void> {
    assertJsonObject(input, `${nodeId}.input`);
    const state = await this.readKnownState(runId, nodeId);
    if (
      state.status !== "READY" &&
      state.status !== "BLOCKED" &&
      state.status !== "PAUSED"
    )
      throw new Error(`节点 ${nodeId} 已开始执行，不能覆盖输入`);
    if (state.attempt > 0)
      throw new Error(`节点 ${nodeId} 已有历史尝试，不能覆盖输入`);
    await this.store.writeInput(runId, nodeId, copyJson(input));
  }

  /** 执行一个已就绪节点，并将本次输入、固定反馈、输出和状态落盘。 */
  async executeNode(runId: string, nodeId: string): Promise<AgentFeedback> {
    if (this.activeRuns.has(runId))
      throw new Error(`运行 ${runId} 正在处理另一个节点`);
    this.activeRuns.add(runId);
    try {
      const plan = await this.loadPlan(runId);
      const node = getNode(plan.graph, nodeId);
      if (!node) throw new Error(`节点不存在: ${nodeId}`);
      const state = await this.store.readState(runId, nodeId);
      if (state.status !== "READY")
        throw new Error(`节点 ${nodeId} 当前状态为 ${state.status}，不能执行`);
      const dependencies: AgentExecutionInput["dependencies"][number][] = [];
      for (const edge of incomingEdges(plan.graph, nodeId)) {
        const sourceState = await this.store.readState(runId, edge.source);
        if (sourceState.status !== "SUCCEEDED")
          throw new Error(`上游节点 ${edge.source} 尚未成功`);
        const output = await this.store.readOutput(runId, edge.source);
        if (!output) throw new Error(`上游节点 ${edge.source} 缺少输出 JSON`);
        assertJsonObject(output, `${edge.source}.output`);
        dependencies.push({
          edgeId: edge.id,
          source: edge.source,
          relation: copyJson(edge.data),
          output: copyJson(output),
        });
      }
      const input = await this.store.readInput(runId, nodeId);
      assertJsonObject(input, `${nodeId}.input`);
      const attempt = state.attempt + 1;
      const request: AgentExecutionInput = freezeJson(
        copyJson({
          runId,
          nodeId,
          attempt,
          agentId: node.data.agentId,
          instruction: node.data.instruction,
          goal: plan.goal,
          input,
          dependencies,
        }),
      );
      await this.store.writeAttemptInput(runId, nodeId, attempt, request);
      await this.store.writeState(
        runId,
        nodeId,
        nextState(state, "RUNNING", undefined, attempt),
      );
      let feedback: AgentFeedback;
      try {
        feedback = parseAgentFeedback(
          await this.options.executor.execute(request),
        );
      } catch (error) {
        feedback = failureFeedback(error);
      }
      await this.store.writeFeedback(runId, nodeId, attempt, feedback);
      const running = await this.store.readState(runId, nodeId);
      await this.store.writeState(
        runId,
        nodeId,
        nextState(
          running,
          feedback.status,
          feedback.status === "FAILED" ? feedback.error : undefined,
        ),
      );
      await this.refreshBlockedNodes(plan);
      return feedback;
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  /** 按拓扑顺序执行所有当前就绪的节点，失败节点不会放行下游。 */
  async executeDag(runId: string): Promise<AgentRunSnapshot> {
    const plan = await this.loadPlan(runId);
    for (const nodeId of topologicalOrder(plan.graph)) {
      const state = await this.store.readState(runId, nodeId);
      if (state.status === "READY") await this.executeNode(runId, nodeId);
    }
    return this.getSnapshot(runId);
  }

  /** 暂停尚未开始执行的节点，保留已有输入与输出文件。 */
  async pauseNode(runId: string, nodeId: string): Promise<AgentNodeState> {
    const state = await this.readKnownState(runId, nodeId);
    if (state.status !== "READY" && state.status !== "BLOCKED")
      throw new Error(`节点 ${nodeId} 当前不能暂停`);
    const paused = nextState(state, "PAUSED", "等待显式恢复");
    await this.store.writeState(runId, nodeId, paused);
    return paused;
  }

  /** 恢复暂停节点，根据当前上游状态决定是否就绪。 */
  async resumeNode(runId: string, nodeId: string): Promise<AgentNodeState> {
    const plan = await this.loadPlan(runId);
    const state = await this.readKnownState(runId, nodeId);
    if (state.status !== "PAUSED") throw new Error(`节点 ${nodeId} 未暂停`);
    const ready = await this.dependenciesSucceeded(plan, nodeId);
    const next = nextState(
      state,
      ready ? "READY" : "BLOCKED",
      ready ? undefined : "等待上游节点成功",
    );
    await this.store.writeState(runId, nodeId, next);
    return next;
  }

  /** 对失败或状态不明的节点显式准备新尝试，旧尝试文件保持不变。 */
  async retryNode(runId: string, nodeId: string): Promise<AgentNodeState> {
    const plan = await this.loadPlan(runId);
    const state = await this.readKnownState(runId, nodeId);
    if (state.status !== "FAILED" && state.status !== "UNKNOWN")
      throw new Error(`节点 ${nodeId} 当前不能重试`);
    const ready = await this.dependenciesSucceeded(plan, nodeId);
    const next = nextState(
      state,
      ready ? "READY" : "BLOCKED",
      ready ? undefined : "等待上游节点成功",
    );
    await this.store.writeState(runId, nodeId, next);
    return next;
  }

  /** 重启后补录已落盘反馈；无反馈的在途执行标记为 UNKNOWN，不自动重发。 */
  async recoverRun(runId: string): Promise<AgentRunSnapshot> {
    if (this.activeRuns.has(runId))
      throw new Error(`运行 ${runId} 仍在执行，不能恢复`);
    const plan = await this.loadPlan(runId);
    for (const node of plan.graph.nodes) {
      const state = await this.store.readState(runId, node.id);
      if (state.status !== "RUNNING") continue;
      const saved = await this.store.readAttemptFeedback(
        runId,
        node.id,
        state.attempt,
      );
      if (saved) {
        const feedback = parseAgentFeedback(saved);
        await this.store.writeFeedback(runId, node.id, state.attempt, feedback);
        await this.store.writeState(
          runId,
          node.id,
          nextState(
            state,
            feedback.status,
            feedback.status === "FAILED" ? feedback.error : undefined,
          ),
        );
      } else {
        await this.store.writeState(
          runId,
          node.id,
          nextState(state, "UNKNOWN", "重启后无法确认 Agent 执行结果"),
        );
      }
    }
    await this.refreshBlockedNodes(plan);
    return this.getSnapshot(runId);
  }

  /** 读取并确认运行清单未指向其他节点文件夹。 */
  private async loadPlan(runId: string): Promise<AgentRunPlan> {
    const plan = await this.store.readRun(runId);
    if (plan.schemaVersion !== 1 || plan.runId !== runId)
      throw new Error("运行清单版本或 ID 不匹配");
    validateGoal(plan.goal);
    const graph = createDag(plan.graph);
    for (const node of graph.nodes) {
      const expected = this.store
        .nodeRelativeDir(node.id)
        .replaceAll("\\", "/");
      if (!node.data || node.data.contextRef?.relativeDir !== expected)
        throw new Error(`节点 ${node.id} 的上下文引用无效`);
    }
    return { ...plan, graph };
  }

  /** 确认一个节点属于此运行，再读取其状态。 */
  private async readKnownState(
    runId: string,
    nodeId: string,
  ): Promise<AgentNodeState> {
    const plan = await this.loadPlan(runId);
    if (!getNode(plan.graph, nodeId)) throw new Error(`节点不存在: ${nodeId}`);
    return this.store.readState(runId, nodeId);
  }

  /** 判断节点的所有输入依赖是否已经成功。 */
  private async dependenciesSucceeded(
    plan: AgentRunPlan,
    nodeId: string,
  ): Promise<boolean> {
    for (const edge of incomingEdges(plan.graph, nodeId)) {
      if (
        (await this.store.readState(plan.runId, edge.source)).status !==
        "SUCCEEDED"
      )
        return false;
    }
    return true;
  }

  /** 上游完成后，把已满足依赖的阻塞节点标记为 READY。 */
  private async refreshBlockedNodes(plan: AgentRunPlan): Promise<void> {
    for (const node of plan.graph.nodes) {
      const state = await this.store.readState(plan.runId, node.id);
      if (
        state.status === "BLOCKED" &&
        (await this.dependenciesSucceeded(plan, node.id))
      ) {
        await this.store.writeState(
          plan.runId,
          node.id,
          nextState(state, "READY"),
        );
      }
    }
  }
}

/** 创建可注入规划器与执行器的 Agent DAG 上下文模块。 */
export function createAgentsDagContext(
  options: AgentsDagContextOptions,
): AgentsDagContext {
  return new AgentsDagContext(options);
}
