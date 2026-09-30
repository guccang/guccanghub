/** DAG 操作与 Agent 节点上下文协作的端到端测试。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  addEdge,
  descendants,
  getNode,
  topologicalOrder,
  type DagEdge,
  type DagNode,
} from "../dag/index.js";
import {
  createAgentsDagContext,
  type AgentExecutionInput,
  type JsonObject,
  type PlannedAgentNode,
} from "../agents-dag-context/index.js";

/** 在可验证的临时目录内运行集成场景。 */
async function withContextDirectory(
  run: (rootDir: string) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "goalsplit-integration-"));
  try {
    await run(rootDir);
  } finally {
    if (resolve(dirname(rootDir)) !== resolve(tmpdir()))
      throw new Error("拒绝清理非临时目录");
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("菱形 DAG 与节点文件夹、依赖输出及恢复后的状态保持一致", async () =>
  withContextDirectory(async (rootDir) => {
    const requests: AgentExecutionInput[] = [];
    const options = {
      rootDir,
      planner: {
        /** 把一个目标拆为分叉后汇合的 DAG，并为每个节点生成输入。 */
        async decompose({
          goal,
        }: {
          goal: { objective: string; context: JsonObject };
        }) {
          const nodes: DagNode<PlannedAgentNode>[] = [
            {
              id: "goal",
              data: {
                agentId: "intake",
                instruction: "解析目标",
                input: { objective: goal.objective },
              },
            },
            {
              id: "research",
              data: {
                agentId: "researcher",
                instruction: "查找事实",
                input: { scope: "facts" },
              },
            },
            {
              id: "design",
              data: {
                agentId: "designer",
                instruction: "设计方案",
                input: { scope: "design" },
              },
            },
            {
              id: "merge",
              data: {
                agentId: "reviewer",
                instruction: "汇总结果",
                input: { criterion: "complete" },
              },
            },
          ];
          const edges: DagEdge<JsonObject>[] = [
            {
              id: "goal-research",
              source: "goal",
              target: "research",
              data: { role: "facts" },
            },
            {
              id: "goal-design",
              source: "goal",
              target: "design",
              data: { role: "design" },
            },
            {
              id: "research-merge",
              source: "research",
              target: "merge",
              data: { role: "evidence" },
            },
            {
              id: "design-merge",
              source: "design",
              target: "merge",
              data: { role: "proposal" },
            },
          ];
          return { nodes, edges };
        },
      },
      executor: {
        /** 返回符合固定协议的 JSON，并保留请求供依赖断言。 */
        async execute(request: AgentExecutionInput) {
          requests.push(request);
          return {
            status: "SUCCEEDED",
            summary: `${request.nodeId} 完成`,
            output: { from: request.nodeId },
          };
        },
      },
    };
    const agents = createAgentsDagContext(options);
    const created = await agents.decomposeGoal("diamond-run", {
      objective: "制定交付方案",
      context: { language: "zh" },
    });
    assert.deepEqual(topologicalOrder(created.graph), [
      "goal",
      "research",
      "design",
      "merge",
    ]);
    assert.deepEqual(descendants(created.graph, "goal"), [
      "research",
      "design",
      "merge",
    ]);
    assert.throws(
      () =>
        addEdge(created.graph, {
          id: "cycle",
          source: "merge",
          target: "goal",
          data: {},
        }),
      /存在环/,
    );

    for (const node of created.graph.nodes) {
      const folder = resolve(
        agents.store.runFolder("diamond-run"),
        node.data.contextRef.relativeDir,
      );
      assert.equal(
        folder,
        resolve(agents.store.nodeFolder("diamond-run", node.id)),
      );
      assert.equal(
        JSON.parse(await readFile(join(folder, "state.json"), "utf8")).nodeId,
        node.id,
      );
      assert.equal(
        typeof JSON.parse(await readFile(join(folder, "input.json"), "utf8")),
        "object",
      );
    }

    await agents.updateNodeInput("diamond-run", "merge", {
      criterion: "verified",
    });
    await agents.pauseNode("diamond-run", "research");
    const partial = await agents.executeDag("diamond-run");
    assert.deepEqual(
      [
        partial.states.goal.status,
        partial.states.research.status,
        partial.states.design.status,
        partial.states.merge.status,
      ],
      ["SUCCEEDED", "PAUSED", "SUCCEEDED", "BLOCKED"],
    );
    assert.deepEqual(
      requests.map((request) => request.nodeId),
      ["goal", "design"],
    );

    const reopened = createAgentsDagContext(options);
    const persisted = await reopened.getSnapshot("diamond-run");
    assert.deepEqual(
      topologicalOrder(persisted.graph),
      topologicalOrder(created.graph),
    );
    assert.equal(
      getNode(persisted.graph, "research")?.data.contextRef.relativeDir,
      getNode(created.graph, "research")?.data.contextRef.relativeDir,
    );
    assert.equal(
      (await reopened.getNodeContext("diamond-run", "research")).state.status,
      "PAUSED",
    );
    await reopened.resumeNode("diamond-run", "research");
    const complete = await reopened.executeDag("diamond-run");
    assert.deepEqual(
      Object.values(complete.states).map((state) => state.status),
      ["SUCCEEDED", "SUCCEEDED", "SUCCEEDED", "SUCCEEDED"],
    );
    assert.deepEqual(
      requests.map((request) => request.nodeId),
      ["goal", "design", "research", "merge"],
    );

    const mergeRequest = requests.at(-1)!;
    assert.deepEqual(mergeRequest.input, { criterion: "verified" });
    assert.deepEqual(
      mergeRequest.dependencies.map((dependency) => ({
        edgeId: dependency.edgeId,
        role: dependency.relation.role,
        output: dependency.output.from,
      })),
      [
        { edgeId: "research-merge", role: "evidence", output: "research" },
        { edgeId: "design-merge", role: "proposal", output: "design" },
      ],
    );
    const mergeContext = await reopened.getNodeContext("diamond-run", "merge");
    assert.equal(mergeContext.feedback?.status, "SUCCEEDED");
    assert.deepEqual(mergeContext.output, { from: "merge" });
    assert.deepEqual(
      mergeContext.state.history.map((change) => change.status),
      ["BLOCKED", "READY", "RUNNING", "SUCCEEDED"],
    );
    assert.equal(
      JSON.parse(
        await readFile(
          join(
            reopened.store.nodeFolder("diamond-run", "merge"),
            "attempts",
            "0001",
            "input.json",
          ),
          "utf8",
        ),
      ).dependencies.length,
      2,
    );
  }));
