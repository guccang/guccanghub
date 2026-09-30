import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "cordis";
import { createDag } from "../dag/index.js";
import { agentsDagPlugin } from "../cordis/index.js";

test("Cordis 注入 Agent 服务、执行 DAG 并随插件卸载", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "cordis-dag-"));
  const ctx = new Context();
  try {
    let injected = false;
    let removed = false;
    ctx.inject(["agentsDag"], (scope) => {
      assert.ok(scope.agentsDag.runtime);
      injected = true;
      scope.on("dispose", () => { removed = true; });
    });
    const fork = ctx.plugin(agentsDagPlugin, {
      rootDir,
      planner: {
        async decompose() {
          return createDag({
            nodes: [
              { id: "first", data: { agentId: "agent", instruction: "开始", input: {} } },
              { id: "second", data: { agentId: "agent", instruction: "完成", input: {} } },
            ],
            edges: [{ id: "dependency", source: "first", target: "second", data: {} }],
          });
        },
      },
      executor: {
        async execute(request) {
          return { status: "SUCCEEDED", summary: request.nodeId, output: { upstreamCount: request.dependencies.length } };
        },
      },
    });
    await ctx.start();
    assert.equal(injected, true);
    await ctx.agentsDag.runtime.decomposeGoal("run", { objective: "测试", context: {} });
    const snapshot = await ctx.agentsDag.runtime.executeDag("run");
    assert.equal(snapshot.states.second.status, "SUCCEEDED");
    assert.deepEqual((await ctx.agentsDag.runtime.getNodeContext("run", "second")).output, { upstreamCount: 1 });
    await fork.dispose();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(removed, true);
    assert.equal(ctx.agentsDag, undefined);
  } finally {
    await ctx.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("配置错误在注册服务前被拒绝", () => {
  const ctx = new Context();
  assert.throws(() => agentsDagPlugin.apply(ctx, {
    rootDir: "",
    planner: { async decompose() { return createDag(); } },
    executor: { async execute() { return {}; } },
  }), /rootDir/);
  assert.equal(ctx.agentsDag, undefined);
});

test('Cordis DAG 服务发布快照、拒绝环且支持取消订阅', async () => {
  const { dagPlugin } = await import('../cordis/dag.js');
  const ctx = new Context();
  const fork = ctx.plugin(dagPlugin);
  await ctx.start();
  try {
    const service = ctx.dagGraph;
    let updates = 0;
    const unsubscribe = service.subscribe(() => { updates++; });
    service.apply([
      { type: 'addNode', node: { id: 'a', data: {} } },
      { type: 'addNode', node: { id: 'b', data: {} } },
      { type: 'addEdge', edge: { id: 'ab', source: 'a', target: 'b', data: {} } },
    ]);
    const snapshot = service.getSnapshot();
    assert.equal(updates, 1);
    assert.throws(() => service.apply([
      { type: 'addEdge', edge: { id: 'ba', source: 'b', target: 'a', data: {} } },
    ]));
    assert.equal(service.getSnapshot(), snapshot);
    assert.equal(updates, 1);
    unsubscribe();
    service.apply([{ type: 'setNodeData', id: 'a', data: { label: '更新' } }]);
    assert.equal(updates, 1);
    await fork.dispose();
    assert.equal(ctx.dagGraph, undefined);
  } finally {
    await ctx.stop();
  }
});
