/** 纯展示组件：只读取 DAG，业务数据由调用者决定如何显示。 */
import { useMemo, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  Position,
  type Edge,
  type ReactFlowInstance,
  type Node,
} from "@xyflow/react";
import {
  topologicalOrder,
  type Dag,
  type DagEdge,
  type DagNode,
} from "../dag/index.js";

/** 可嵌入 DAG 视图的参数。 */
export interface DagViewProps<N, E> {
  graph: Dag<N, E>;
  nodeLabel?: (node: DagNode<N>) => string;
  edgeLabel?: (edge: DagEdge<E>) => string;
  nodeClassName?: (node: DagNode<N>) => string;
  selected?: { type: "node" | "edge"; id: string } | null;
  onNodeSelect?: (node: DagNode<N>) => void;
  onEdgeSelect?: (edge: DagEdge<E>) => void;
  className?: string;
}

/** 按拓扑层次为节点计算初始位置，位置不写入 DAG 语义数据。 */
function layoutDag<N, E>(
  graph: Dag<N, E>,
): Map<string, { x: number; y: number }> {
  const layers = new Map<string, number>();
  for (const id of topologicalOrder(graph)) {
    const parents = graph.edges.filter((edge) => edge.target === id);
    layers.set(
      id,
      parents.length
        ? Math.max(...parents.map((edge) => (layers.get(edge.source) ?? 0) + 1))
        : 0,
    );
  }
  const rows = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const id of topologicalOrder(graph)) {
    const layer = layers.get(id)!;
    const row = rows.get(layer) ?? 0;
    positions.set(id, { x: layer * 280, y: row * 130 });
    rows.set(layer, row + 1);
  }
  return positions;
}

/** 根据传入图展示节点和边，并把选择结果原样返回给宿主。 */
export function DagView<N, E>({
  graph,
  nodeLabel,
  edgeLabel,
  nodeClassName,
  selected,
  onNodeSelect,
  onEdgeSelect,
  className,
}: DagViewProps<N, E>) {
  const container = useRef<HTMLDivElement>(null);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  useEffect(() => {
    if (!flow || !container.current) return;
    const observer = new ResizeObserver(() => { void flow.fitView({ padding: 0.22, minZoom: 0.1 }); });
    observer.observe(container.current);
    return () => { observer.disconnect(); };
  }, [flow]);
  const positions = useMemo(() => layoutDag(graph), [graph]);
  const nodes: Node[] = graph.nodes.map((node) => ({
    id: node.id,
    data: { label: nodeLabel?.(node) ?? node.id },
    position: positions.get(node.id)!,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    selected: selected?.type === "node" && selected.id === node.id,
    className: `goalsplit-node ${nodeClassName?.(node) ?? ""}`,
  }));
  const edges: Edge[] = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edgeLabel?.(edge) ?? undefined,
    selected: selected?.type === "edge" && selected.id === edge.id,
    markerEnd: { type: MarkerType.ArrowClosed },
    className: "goalsplit-edge",
  }));
  return (
    <div ref={container} className={`goalsplit-dag-view ${className ?? ""}`}>
      <ReactFlow
        key={`${graph.nodes.map((node) => node.id).join("|")}:${graph.edges.map((edge) => `${edge.id}/${edge.source}/${edge.target}`).join("|")}`}
        nodes={nodes}
        edges={edges}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.1}
        onInit={setFlow}
        fitView
        fitViewOptions={{ padding: 0.22 }}
        onNodeClick={(_, item) => {
          const node = graph.nodes.find((value) => value.id === item.id);
          if (node) onNodeSelect?.(node);
        }}
        onEdgeClick={(_, item) => {
          const edge = graph.edges.find((value) => value.id === item.id);
          if (edge) onEdgeSelect?.(edge);
        }}
      >
        <Background color="#e0e9ef" gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
