/** 核心 DAG 操作的边界与数据绑定测试。 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  addEdge,
  addNode,
  ancestors,
  applyDagOperations,
  createDag,
  DagError,
  descendants,
  getEdge,
  getNode,
  incomingEdges,
  outgoingEdges,
  removeNode,
  setEdgeData,
  setEdgeEndpoints,
  setNodeData,
  topologicalOrder,
  type Dag,
} from "../dag/index.js";

type NodeData = { title: string };
type EdgeData = { kind: string; required: boolean };

/** 创建用于验证分叉汇合关系的样本图。 */
function diamond(): Dag<NodeData, EdgeData> {
  return createDag({
    nodes: ["a", "b", "c", "d"].map((id) => ({ id, data: { title: id } })),
    edges: [
      {
        id: "ab",
        source: "a",
        target: "b",
        data: { kind: "input", required: true },
      },
      {
        id: "ac",
        source: "a",
        target: "c",
        data: { kind: "input", required: false },
      },
      {
        id: "bd",
        source: "b",
        target: "d",
        data: { kind: "result", required: true },
      },
      {
        id: "cd",
        source: "c",
        target: "d",
        data: { kind: "result", required: true },
      },
    ],
  });
}

test("节点和边独立绑定数据，变更返回新图", () => {
  const original = diamond();
  const changed = setEdgeData(
    setNodeData(original, "a", { title: "updated" }),
    "ab",
    { kind: "changed", required: false },
  );
  assert.equal(getNode(changed, "a")?.data.title, "updated");
  assert.equal(getEdge(changed, "ab")?.data.kind, "changed");
  assert.equal(getNode(original, "a")?.data.title, "a");
  assert.equal(getEdge(original, "ab")?.data.kind, "input");
});

test("图结构浅冻结，外部改动不影响已创建的图", () => {
  const input = { id: "a", data: { title: "原数据" } };
  const graph = createDag<NodeData, EdgeData>({ nodes: [input], edges: [] });
  input.id = "changed";
  assert.equal(graph.nodes[0].id, "a");
  assert.equal(Object.isFrozen(graph.nodes), true);
  assert.equal(Object.isFrozen(graph.nodes[0]), true);
  assert.equal(graph.nodes[0].data, input.data);
});

test("调整边端点保留其数据，并拒绝成环修改", () => {
  const graph = diamond();
  const changed = setEdgeEndpoints(graph, "ab", "b", "c");
  assert.deepEqual(
    [getEdge(changed, "ab")?.source, getEdge(changed, "ab")?.target],
    ["b", "c"],
  );
  assert.equal(getEdge(changed, "ab")?.data, getEdge(graph, "ab")?.data);
  assert.throws(
    () => setEdgeEndpoints(graph, "ab", "d", "a"),
    (error: unknown) => error instanceof DagError && error.code === "CYCLE",
  );
  assert.equal(getEdge(graph, "ab")?.source, "a");
});

test("拓扑排序、前后继和关联边可查询", () => {
  const graph = diamond();
  assert.deepEqual(topologicalOrder(graph), ["a", "b", "c", "d"]);
  assert.deepEqual(descendants(graph, "a"), ["b", "c", "d"]);
  assert.deepEqual(ancestors(graph, "d"), ["a", "b", "c"]);
  assert.deepEqual(
    incomingEdges(graph, "d").map((edge) => edge.id),
    ["bd", "cd"],
  );
  assert.deepEqual(
    outgoingEdges(graph, "a").map((edge) => edge.id),
    ["ab", "ac"],
  );
});

test("删除节点自动删除关联边，保留无关分支", () => {
  const changed = removeNode(diamond(), "b");
  assert.deepEqual(
    changed.nodes.map((node) => node.id),
    ["a", "c", "d"],
  );
  assert.deepEqual(
    changed.edges.map((edge) => edge.id),
    ["ac", "cd"],
  );
});

test("无效端点、重复 ID、环和自身连接均被拒绝", () => {
  const graph = diamond();
  assert.throws(
    () =>
      addEdge(graph, {
        id: "missing",
        source: "a",
        target: "x",
        data: { kind: "", required: true },
      }),
    (error: unknown) =>
      error instanceof DagError && error.code === "MISSING_NODE",
  );
  assert.throws(
    () => addNode(graph, { id: "a", data: { title: "" } }),
    (error: unknown) =>
      error instanceof DagError && error.code === "DUPLICATE_ID",
  );
  assert.throws(
    () =>
      addEdge(graph, {
        id: "da",
        source: "d",
        target: "a",
        data: { kind: "", required: true },
      }),
    (error: unknown) => error instanceof DagError && error.code === "CYCLE",
  );
  assert.throws(
    () =>
      addEdge(graph, {
        id: "aa",
        source: "a",
        target: "a",
        data: { kind: "", required: true },
      }),
    (error: unknown) => error instanceof DagError && error.code === "CYCLE",
  );
});

test("批量操作校验最终结构，错误不污染原图", () => {
  const graph = diamond();
  const changed = applyDagOperations(graph, [
    {
      type: "addEdge",
      edge: {
        id: "de",
        source: "d",
        target: "e",
        data: { kind: "output", required: true },
      },
    },
    { type: "addNode", node: { id: "e", data: { title: "e" } } },
  ]);
  assert.deepEqual(topologicalOrder(changed), ["a", "b", "c", "d", "e"]);
  assert.equal(graph.nodes.length, 4);
  assert.throws(
    () =>
      applyDagOperations(graph, [
        { type: "removeNode", id: "a" },
        {
          type: "addEdge",
          edge: {
            id: "bad",
            source: "d",
            target: "b",
            data: { kind: "", required: true },
          },
        },
      ]),
    (error: unknown) => error instanceof DagError && error.code === "CYCLE",
  );
  assert.equal(graph.edges.length, 4);
});

test("导入结构必须含节点和边数组，且元素均声明数据", () => {
  assert.throws(
    () => createDag(null as unknown as Dag),
    (error: unknown) =>
      error instanceof DagError && error.code === "INVALID_GRAPH",
  );
  assert.throws(
    () => createDag({ nodes: [] } as unknown as Dag),
    (error: unknown) =>
      error instanceof DagError && error.code === "INVALID_GRAPH",
  );
  assert.throws(
    () => createDag({ nodes: [{ id: "a" }], edges: [] } as unknown as Dag),
    (error: unknown) =>
      error instanceof DagError && error.code === "INVALID_GRAPH",
  );
  assert.throws(
    () =>
      createDag({
        nodes: [{ id: "a", data: null }],
        edges: [{ id: "e", source: 1, target: "a", data: null }],
      } as unknown as Dag),
    (error: unknown) =>
      error instanceof DagError && error.code === "INVALID_GRAPH",
  );
});
