/** 无业务依赖的 DAG 创建、查询、遍历及变更。 */
import type { Dag, DagEdge, DagNode, DagOperation } from "./types.js";

/** 图结构非法时的错误。 */
export class DagError extends Error {
  /** 创建包含机器可识别错误码的错误。 */
  constructor(
    readonly code:
      | "INVALID_GRAPH"
      | "INVALID_ID"
      | "DUPLICATE_ID"
      | "MISSING_NODE"
      | "MISSING_EDGE"
      | "CYCLE",
    message: string,
  ) {
    super(message);
    this.name = "DagError";
  }
}

/** 创建空图，或验证并复制已有图的节点和边数组。 */
export function createDag<N = unknown, E = unknown>(
  initial?: Dag<N, E>,
): Dag<N, E> {
  if (
    initial !== undefined &&
    (!initial || !Array.isArray(initial.nodes) || !Array.isArray(initial.edges))
  )
    throw new DagError("INVALID_GRAPH", "图必须包含 nodes 和 edges 数组");
  const graph = {
    nodes: (initial?.nodes ?? []).map((node) => Object.freeze({ ...node })),
    edges: (initial?.edges ?? []).map((edge) => Object.freeze({ ...edge })),
  };
  validateDag(graph);
  return Object.freeze({
    nodes: Object.freeze(graph.nodes),
    edges: Object.freeze(graph.edges),
  });
}

/** 校验 ID、端点和环，同时返回稳定的拓扑节点 ID 顺序。 */
export function topologicalOrder<N, E>(graph: Dag<N, E>): string[] {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
    throw new DagError("INVALID_GRAPH", "图必须包含 nodes 和 edges 数组");
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== "string" || !node.id.trim())
      throw new DagError("INVALID_ID", "节点 ID 必须是非空字符串");
    if (!("data" in node))
      throw new DagError("INVALID_GRAPH", `节点 ${node.id} 缺少 data`);
    if (ids.has(node.id))
      throw new DagError("DUPLICATE_ID", `重复节点 ID: ${node.id}`);
    ids.add(node.id);
  }
  const edgeIds = new Set<string>();
  const indegree = new Map([...ids].map((id) => [id, 0]));
  const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
  for (const edge of graph.edges) {
    if (!edge || typeof edge.id !== "string" || !edge.id.trim())
      throw new DagError("INVALID_ID", "边 ID 必须是非空字符串");
    if (!("data" in edge))
      throw new DagError("INVALID_GRAPH", `边 ${edge.id} 缺少 data`);
    if (typeof edge.source !== "string" || typeof edge.target !== "string")
      throw new DagError("INVALID_GRAPH", `边 ${edge.id} 的端点必须是字符串`);
    if (edgeIds.has(edge.id))
      throw new DagError("DUPLICATE_ID", `重复边 ID: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!ids.has(edge.source))
      throw new DagError(
        "MISSING_NODE",
        `边 ${edge.id} 的起点不存在: ${edge.source}`,
      );
    if (!ids.has(edge.target))
      throw new DagError(
        "MISSING_NODE",
        `边 ${edge.id} 的终点不存在: ${edge.target}`,
      );
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const ready = graph.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id);
  const order: string[] = [];
  for (let head = 0; head < ready.length; head++) {
    const id = ready[head];
    order.push(id);
    for (const next of outgoing.get(id)!) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  if (order.length !== graph.nodes.length)
    throw new DagError("CYCLE", "DAG 中存在环");
  return order;
}

/** 验证完整图，不修改输入。 */
export function validateDag<N, E>(graph: Dag<N, E>): void {
  topologicalOrder(graph);
}

/** 按 ID 读取节点。 */
export function getNode<N, E>(
  graph: Dag<N, E>,
  id: string,
): DagNode<N> | undefined {
  return graph.nodes.find((node) => node.id === id);
}

/** 按 ID 读取边。 */
export function getEdge<N, E>(
  graph: Dag<N, E>,
  id: string,
): DagEdge<E> | undefined {
  return graph.edges.find((edge) => edge.id === id);
}

/** 确认查询起点存在。 */
function requireNode<N, E>(graph: Dag<N, E>, id: string): void {
  if (!getNode(graph, id))
    throw new DagError("MISSING_NODE", `节点不存在: ${id}`);
}

/** 读取指向节点的边。 */
export function incomingEdges<N, E>(
  graph: Dag<N, E>,
  id: string,
): DagEdge<E>[] {
  requireNode(graph, id);
  return graph.edges.filter((edge) => edge.target === id);
}

/** 读取从节点出发的边。 */
export function outgoingEdges<N, E>(
  graph: Dag<N, E>,
  id: string,
): DagEdge<E>[] {
  requireNode(graph, id);
  return graph.edges.filter((edge) => edge.source === id);
}

/** 读取所有后继节点 ID，按拓扑顺序返回。 */
export function descendants<N, E>(graph: Dag<N, E>, id: string): string[] {
  requireNode(graph, id);
  const seen = new Set<string>();
  const queue = [id];
  for (let head = 0; head < queue.length; head++) {
    for (const edge of graph.edges)
      if (edge.source === queue[head] && !seen.has(edge.target)) {
        seen.add(edge.target);
        queue.push(edge.target);
      }
  }
  return topologicalOrder(graph).filter((nodeId) => seen.has(nodeId));
}

/** 读取所有前驱节点 ID，按拓扑顺序返回。 */
export function ancestors<N, E>(graph: Dag<N, E>, id: string): string[] {
  requireNode(graph, id);
  const seen = new Set<string>();
  const queue = [id];
  for (let head = 0; head < queue.length; head++) {
    for (const edge of graph.edges)
      if (edge.target === queue[head] && !seen.has(edge.source)) {
        seen.add(edge.source);
        queue.push(edge.source);
      }
  }
  return topologicalOrder(graph).filter((nodeId) => seen.has(nodeId));
}

/** 在副本上应用多个操作，只在最终结构合法时返回新图。 */
export function applyDagOperations<N, E>(
  graph: Dag<N, E>,
  operations: readonly DagOperation<N, E>[],
): Dag<N, E> {
  validateDag(graph);
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  for (const operation of operations) {
    switch (operation.type) {
      case "addNode":
        if (nodes.some((node) => node.id === operation.node.id))
          throw new DagError(
            "DUPLICATE_ID",
            `重复节点 ID: ${operation.node.id}`,
          );
        nodes.push(operation.node);
        break;
      case "setNodeData": {
        const index = nodes.findIndex((node) => node.id === operation.id);
        if (index < 0)
          throw new DagError("MISSING_NODE", `节点不存在: ${operation.id}`);
        nodes[index] = { ...nodes[index], data: operation.data };
        break;
      }
      case "removeNode": {
        const index = nodes.findIndex((node) => node.id === operation.id);
        if (index < 0)
          throw new DagError("MISSING_NODE", `节点不存在: ${operation.id}`);
        nodes.splice(index, 1);
        for (let i = edges.length - 1; i >= 0; i--)
          if (
            edges[i].source === operation.id ||
            edges[i].target === operation.id
          )
            edges.splice(i, 1);
        break;
      }
      case "addEdge":
        if (edges.some((edge) => edge.id === operation.edge.id))
          throw new DagError("DUPLICATE_ID", `重复边 ID: ${operation.edge.id}`);
        edges.push(operation.edge);
        break;
      case "setEdgeEndpoints": {
        const index = edges.findIndex((edge) => edge.id === operation.id);
        if (index < 0)
          throw new DagError("MISSING_EDGE", `边不存在: ${operation.id}`);
        edges[index] = {
          ...edges[index],
          source: operation.source,
          target: operation.target,
        };
        break;
      }
      case "setEdgeData": {
        const index = edges.findIndex((edge) => edge.id === operation.id);
        if (index < 0)
          throw new DagError("MISSING_EDGE", `边不存在: ${operation.id}`);
        edges[index] = { ...edges[index], data: operation.data };
        break;
      }
      case "removeEdge": {
        const index = edges.findIndex((edge) => edge.id === operation.id);
        if (index < 0)
          throw new DagError("MISSING_EDGE", `边不存在: ${operation.id}`);
        edges.splice(index, 1);
        break;
      }
    }
  }
  return createDag({ nodes, edges });
}

/** 添加节点。 */
export function addNode<N, E>(graph: Dag<N, E>, node: DagNode<N>): Dag<N, E> {
  return applyDagOperations(graph, [{ type: "addNode", node }]);
}
/** 替换节点数据。 */
export function setNodeData<N, E>(
  graph: Dag<N, E>,
  id: string,
  data: N,
): Dag<N, E> {
  return applyDagOperations(graph, [{ type: "setNodeData", id, data }]);
}
/** 删除节点及其关联边。 */
export function removeNode<N, E>(graph: Dag<N, E>, id: string): Dag<N, E> {
  return applyDagOperations(graph, [{ type: "removeNode", id }]);
}
/** 添加边。 */
export function addEdge<N, E>(graph: Dag<N, E>, edge: DagEdge<E>): Dag<N, E> {
  return applyDagOperations(graph, [{ type: "addEdge", edge }]);
}
/** 修改边的起点和终点，同时验证最终图仍为 DAG。 */
export function setEdgeEndpoints<N, E>(
  graph: Dag<N, E>,
  id: string,
  source: string,
  target: string,
): Dag<N, E> {
  return applyDagOperations(graph, [
    { type: "setEdgeEndpoints", id, source, target },
  ]);
}
/** 替换边数据。 */
export function setEdgeData<N, E>(
  graph: Dag<N, E>,
  id: string,
  data: E,
): Dag<N, E> {
  return applyDagOperations(graph, [{ type: "setEdgeData", id, data }]);
}
/** 删除边。 */
export function removeEdge<N, E>(graph: Dag<N, E>, id: string): Dag<N, E> {
  return applyDagOperations(graph, [{ type: "removeEdge", id }]);
}
