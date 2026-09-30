/** DAG 节点定义；数据类型由宿主决定。 */
export interface DagNode<NodeData = unknown> {
  readonly id: string;
  readonly data: NodeData;
}

/** DAG 边有独立 ID 和数据，可用于存储条件、权重等业务信息。 */
export interface DagEdge<EdgeData = unknown> {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly data: EdgeData;
}

/** 与执行、存储和视图无关的图结构。 */
export interface Dag<NodeData = unknown, EdgeData = unknown> {
  readonly nodes: readonly DagNode<NodeData>[];
  readonly edges: readonly DagEdge<EdgeData>[];
}

/** 用于原子修改 DAG 的操作。 */
export type DagOperation<NodeData, EdgeData> =
  | { readonly type: "addNode"; readonly node: DagNode<NodeData> }
  | {
      readonly type: "setNodeData";
      readonly id: string;
      readonly data: NodeData;
    }
  | { readonly type: "removeNode"; readonly id: string }
  | { readonly type: "addEdge"; readonly edge: DagEdge<EdgeData> }
  | {
      readonly type: "setEdgeEndpoints";
      readonly id: string;
      readonly source: string;
      readonly target: string;
    }
  | {
      readonly type: "setEdgeData";
      readonly id: string;
      readonly data: EdgeData;
    }
  | { readonly type: "removeEdge"; readonly id: string };
