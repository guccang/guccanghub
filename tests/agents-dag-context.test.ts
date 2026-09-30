/** Agent DAG 上下文的文件、协议、状态与恢复测试。 */
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  createAgentsDagContext,
  type AgentExecutionInput,
  type AgentNodeState,
  type AgentPlannerPort,
  type PlannedAgentNode,
} from "../src/agents-dag-context/index.js";
import type { DagNode } from "../src/index.js";

/** 在独立临时目录中执行测试并安全清理该目录。 */
async function withTempDir(
  run: (rootDir: string) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "goalsplit-context-"));
  try {
    await run(rootDir);
  } finally {
    if (resolve(dirname(rootDir)) !== resolve(tmpdir()))
      throw new Error("临时目录不在系统临时根目录下");
    await rm(rootDir, { recursive: true, force: true });
  }
}

/** 生成拥有一条依赖边的可控规划器。 */
function planner(): AgentPlannerPort {
  return {
    async decompose({ goal }) {
      const nodes: DagNode<PlannedAgentNode>[] = [
        {
          id: "research",
          data: {
            agentId: "researcher",
            instruction: "收集资料",
            input: { topic: goal.objective },
          },
        },
        {
          id: "review",
          data: {
            agentId: "reviewer",
            instruction: "审核资料",
            input: { criteria: "准确性" },
          },
        },
      ];
      return {
        nodes,
        edges: [
          {
            id: "needs-research",
            source: "research",
            target: "review",
            data: { required: true },
          },
        ],
      };
    },
  };
}

test("规划器拆解目标后为每个 DAG 节点建立输入和状态文件", async () =>
  withTempDir(async (rootDir) => {
    const agents = createAgentsDagContext({
      rootDir,
      planner: planner(),
      executor: {
        async execute() {
          throw new Error("不应执行");
        },
      },
    });
    const snapshot = await agents.decomposeGoal("run-1", {
      objective: "完成调研",
      context: { language: "zh" },
    });
    assert.equal(snapshot.graph.nodes.length, 2);
    assert.equal(snapshot.states.research.status, "READY");
    assert.equal(snapshot.states.review.status, "BLOCKED");
    assert.match(
      snapshot.graph.nodes[0].data.contextRef.relativeDir,
      /^nodes\/node-[0-9a-f]{64}$/,
    );
    const folder = agents.store.nodeFolder("run-1", "research");
    assert.deepEqual(
      JSON.parse(await readFile(join(folder, "input.json"), "utf8")),
      { topic: "完成调研" },
    );
    assert.equal(
      JSON.parse(await readFile(join(folder, "state.json"), "utf8")).history
        .length,
      1,
    );
    await assert.rejects(
      () => agents.decomposeGoal("run-1", { objective: "重复", context: {} }),
      /已存在/,
    );
  }));

test("依赖输出和边数据进入下游输入，每次输入、反馈、输出和状态均落盘", async () =>
  withTempDir(async (rootDir) => {
    const requests: AgentExecutionInput[] = [];
    const agents = createAgentsDagContext({
      rootDir,
      planner: planner(),
      executor: {
        async execute(request) {
          requests.push(request);
          return {
            status: "SUCCEEDED",
            summary: "完成",
            output: { producedBy: request.nodeId },
          };
        },
      },
    });
    await agents.decomposeGoal("run-2", { objective: "研究 DAG", context: {} });
    await agents.updateNodeInput("run-2", "review", { criteria: "完整性" });
    const result = await agents.executeDag("run-2");
    assert.deepEqual(
      [result.states.research.status, result.states.review.status],
      ["SUCCEEDED", "SUCCEEDED"],
    );
    assert.deepEqual(requests[1].dependencies, [
      {
        edgeId: "needs-research",
        source: "research",
        relation: { required: true },
        output: { producedBy: "research" },
      },
    ]);
    assert.deepEqual(requests[1].input, { criteria: "完整性" });
    assert.equal(Object.isFrozen(requests[1].dependencies[0].output), true);
    await assert.rejects(
      () => agents.updateNodeInput("run-2", "review", { criteria: "迟到修改" }),
      /不能覆盖输入/,
    );
    const context = await agents.getNodeContext("run-2", "review");
    assert.deepEqual(context.output, { producedBy: "review" });
    assert.deepEqual(
      context.state.history.map((change) => change.status),
      ["BLOCKED", "READY", "RUNNING", "SUCCEEDED"],
    );
    const folder = agents.store.nodeFolder("run-2", "review");
    assert.equal(
      JSON.parse(
        await readFile(join(folder, "attempts", "0001", "input.json"), "utf8"),
      ).dependencies[0].source,
      "research",
    );
    assert.equal(
      JSON.parse(await readFile(join(folder, "feedback.json"), "utf8")).status,
      "SUCCEEDED",
    );
    assert.equal(
      JSON.parse(await readFile(join(folder, "output.json"), "utf8"))
        .producedBy,
      "review",
    );
  }));

test("无效反馈记录为失败，显式重试保留旧尝试，暂停状态跨实例保留", async () =>
  withTempDir(async (rootDir) => {
    let count = 0;
    const options = {
      rootDir,
      planner: planner(),
      executor: {
        async execute() {
          count++;
          return count === 1
            ? { status: "done", output: 1 }
            : {
                status: "SUCCEEDED",
                summary: "修复完成",
                output: { ok: true },
              };
        },
      },
    };
    const agents = createAgentsDagContext(options);
    await agents.decomposeGoal("run-3", { objective: "测试", context: {} });
    const failed = await agents.executeNode("run-3", "research");
    assert.equal(failed.status, "FAILED");
    assert.equal(
      (await agents.getSnapshot("run-3")).states.review.status,
      "BLOCKED",
    );
    await agents.retryNode("run-3", "research");
    const succeeded = await agents.executeNode("run-3", "research");
    assert.equal(succeeded.status, "SUCCEEDED");
    assert.equal(
      (await agents.getSnapshot("run-3")).states.review.status,
      "READY",
    );
    await agents.pauseNode("run-3", "review");
    const reopened = createAgentsDagContext(options);
    assert.equal(
      (await reopened.getSnapshot("run-3")).states.review.status,
      "PAUSED",
    );
    await reopened.resumeNode("run-3", "review");
    assert.equal(
      (await reopened.getSnapshot("run-3")).states.review.status,
      "READY",
    );
    const folder = agents.store.nodeFolder("run-3", "research");
    assert.equal(
      JSON.parse(
        await readFile(
          join(folder, "attempts", "0001", "feedback.json"),
          "utf8",
        ),
      ).status,
      "FAILED",
    );
    assert.equal(
      JSON.parse(
        await readFile(
          join(folder, "attempts", "0002", "feedback.json"),
          "utf8",
        ),
      ).status,
      "SUCCEEDED",
    );
  }));

test("重启恢复补录已有反馈，未确认的调用标记 UNKNOWN 且不自动重发", async () =>
  withTempDir(async (rootDir) => {
    let called = 0;
    const agents = createAgentsDagContext({
      rootDir,
      planner: planner(),
      executor: {
        async execute() {
          called++;
          throw new Error("不应自动执行");
        },
      },
    });
    await agents.decomposeGoal("run-4", { objective: "恢复", context: {} });
    const original = (await agents.getSnapshot("run-4")).states.research;
    const running: AgentNodeState = {
      ...original,
      status: "RUNNING",
      attempt: 1,
      history: [
        ...original.history,
        { status: "RUNNING", at: new Date().toISOString() },
      ],
    };
    await agents.store.writeAttemptInput("run-4", "research", 1, { input: {} });
    await agents.store.writeState("run-4", "research", running);
    const unknown = await agents.recoverRun("run-4");
    assert.equal(unknown.states.research.status, "UNKNOWN");
    assert.equal(called, 0);
    await agents.retryNode("run-4", "research");
    const ready = (await agents.getSnapshot("run-4")).states.research;
    const runningAgain: AgentNodeState = {
      ...ready,
      status: "RUNNING",
      attempt: 2,
      history: [
        ...ready.history,
        { status: "RUNNING", at: new Date().toISOString() },
      ],
    };
    await agents.store.writeAttemptInput("run-4", "research", 2, { input: {} });
    await agents.store.writeState("run-4", "research", runningAgain);
    await agents.store.writeFeedback("run-4", "research", 2, {
      status: "SUCCEEDED",
      summary: "已完成",
      output: { recovered: true },
    });
    const recovered = await agents.recoverRun("run-4");
    assert.equal(recovered.states.research.status, "SUCCEEDED");
    assert.equal(recovered.states.review.status, "READY");
    assert.equal(called, 0);
  }));

test("非法 DAG、非 JSON 输入及路径型 ID 在发布前或路径计算时受到约束", async () =>
  withTempDir(async (rootDir) => {
    const invalid = createAgentsDagContext({
      rootDir,
      planner: {
        async decompose() {
          return {
            nodes: [
              {
                id: "a",
                data: {
                  agentId: "x",
                  instruction: "x",
                  input: { bad: undefined } as never,
                },
              },
            ],
            edges: [],
          };
        },
      },
      executor: {
        async execute() {
          throw new Error("不应执行");
        },
      },
    });
    await assert.rejects(
      () => invalid.decomposeGoal("invalid", { objective: "x", context: {} }),
      /有效 JSON/,
    );
    const cyclic = createAgentsDagContext({
      rootDir,
      planner: {
        async decompose() {
          return {
            nodes: [
              { id: "a", data: { agentId: "a", instruction: "a", input: {} } },
              { id: "b", data: { agentId: "b", instruction: "b", input: {} } },
            ],
            edges: [
              { id: "ab", source: "a", target: "b", data: {} },
              { id: "ba", source: "b", target: "a", data: {} },
            ],
          };
        },
      },
      executor: {
        async execute() {
          throw new Error("不应执行");
        },
      },
    });
    await assert.rejects(
      () => cyclic.decomposeGoal("cyclic", { objective: "x", context: {} }),
      /存在环/,
    );
    const weird = invalid.store.nodeFolder("../run", "../node");
    assert.equal(weird.startsWith(resolve(rootDir)), true);
    assert.equal(weird.includes(".."), false);
  }));
