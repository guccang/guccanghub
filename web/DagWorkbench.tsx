/** 演示工作台只组合公开 DAG API 与展示组件，不依赖任何执行运行时。 */
import React, { useEffect, useState, type FormEvent } from "react";
import {
  addEdge,
  addNode,
  applyDagOperations,
  createDag,
  getEdge,
  getNode,
  removeEdge,
  removeNode,
  setNodeData,
  topologicalOrder,
  type Dag,
  type DagEdge,
  type DagNode,
} from "../src/index.js";
import { DagView } from "./DagView.js";

type Data = Record<string, unknown>;
type DemoDag = Dag<Data, Data>;
type Selection = { type: "node" | "edge"; id: string } | null;
type Mode = "node" | "edge" | "import" | null;
const storageKey = "goalsplit-dag-demo-v1";

/** 生成覆盖分叉与汇合的示例图。 */
function sampleDag(): DemoDag {
  return createDag<Data, Data>({
    nodes: [
      { id: "goal", data: { label: "定义目标", kind: "input", owner: "用户" } },
      {
        id: "research",
        data: { label: "收集资料", kind: "task", owner: "研究模块" },
      },
      {
        id: "design",
        data: { label: "设计方案", kind: "task", owner: "设计模块" },
      },
      {
        id: "review",
        data: { label: "汇总评审", kind: "review", owner: "审核模块" },
      },
    ],
    edges: [
      {
        id: "e-goal-research",
        source: "goal",
        target: "research",
        data: { label: "输入", required: true },
      },
      {
        id: "e-goal-design",
        source: "goal",
        target: "design",
        data: { label: "约束", required: true },
      },
      {
        id: "e-research-review",
        source: "research",
        target: "review",
        data: { label: "资料", required: true },
      },
      {
        id: "e-design-review",
        source: "design",
        target: "review",
        data: { label: "方案", required: true },
      },
    ],
  });
}

/** 验证导入图中的数据符合演示编辑器使用的 JSON 对象格式。 */
function createDemoDag(value: DemoDag): DemoDag {
  const graph = createDag<Data, Data>(value);
  for (const item of [...graph.nodes, ...graph.edges]) {
    if (
      item.data === null ||
      Array.isArray(item.data) ||
      typeof item.data !== "object"
    )
      throw new Error(`${item.id} 的数据必须是 JSON 对象`);
  }
  return graph;
}

/** 从浏览器草稿恢复经过验证的图，损坏草稿回退到示例。 */
function loadDag(): DemoDag {
  try {
    const saved = localStorage.getItem(storageKey);
    return saved ? createDemoDag(JSON.parse(saved) as DemoDag) : sampleDag();
  } catch {
    return sampleDag();
  }
}

/** 将未知 JSON 转成适合演示编辑器的数据对象。 */
function parseData(text: string): Data {
  const value: unknown = JSON.parse(text);
  if (value === null || Array.isArray(value) || typeof value !== "object")
    throw new Error("数据必须是 JSON 对象");
  return value as Data;
}

/** 把绑定数据中的 label 用作图上标题。 */
function labelOf(item: DagNode<Data> | DagEdge<Data>): string {
  return typeof item.data.label === "string" && item.data.label.trim()
    ? item.data.label
    : item.id;
}

/** 演示增删节点/边、修改数据、校验与本地草稿的可交互页面。 */
export function DagWorkbench() {
  const [graph, setGraph] = useState<DemoDag>(loadDag);
  const [selected, setSelected] = useState<Selection>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [id, setId] = useState("");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [dataText, setDataText] = useState('{\n  "label": "新节点"\n}');
  const [importText, setImportText] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const currentNode =
    selected?.type === "node" ? getNode(graph, selected.id) : undefined;
  const currentEdge =
    selected?.type === "edge" ? getEdge(graph, selected.id) : undefined;
  const current = currentNode ?? currentEdge;

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(graph));
  }, [graph]);
  useEffect(() => {
    if (current) setDataText(JSON.stringify(current.data, null, 2));
  }, [selected?.type, selected?.id]);

  /** 统一提交结构修改，并在界面显示校验失败原因。 */
  function commit(change: () => DemoDag, message: string) {
    try {
      setGraph(change());
      setError("");
      setNotice(message);
      setMode(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setNotice("");
    }
  }

  /** 打开新建表单并清空上次输入。 */
  function openMode(next: Mode) {
    setMode(next);
    setSelected(null);
    setError("");
    setNotice("");
    setId("");
    setSource("");
    setTarget("");
    setDataText(
      next === "edge" ? '{\n  "label": "依赖"\n}' : '{\n  "label": "新节点"\n}',
    );
  }

  /** 提交新节点或新边。 */
  function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = id.trim();
    if (mode === "node")
      commit(
        () => addNode(graph, { id: key, data: parseData(dataText) }),
        `已添加节点 ${key}`,
      );
    if (mode === "edge")
      commit(
        () =>
          addEdge(graph, {
            id: key,
            source,
            target,
            data: parseData(dataText),
          }),
        `已添加边 ${key}`,
      );
  }

  /** 保存当前节点数据，或原子保存边端点及边数据。 */
  function saveData(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    commit(
      () =>
        selected.type === "node"
          ? setNodeData(graph, selected.id, parseData(dataText))
          : applyDagOperations(graph, [
              { type: "setEdgeEndpoints", id: selected.id, source, target },
              {
                type: "setEdgeData",
                id: selected.id,
                data: parseData(dataText),
              },
            ]),
      `已更新${selected.type === "node" ? "节点数据" : "边与绑定数据"}`,
    );
  }

  /** 删除选中元素，删除节点时由图内核自动清理关联边。 */
  function deleteSelected() {
    if (!selected) return;
    commit(
      () =>
        selected.type === "node"
          ? removeNode(graph, selected.id)
          : removeEdge(graph, selected.id),
      `已删除 ${selected.id}`,
    );
    setSelected(null);
  }

  /** 校验并导入完整 DAG JSON。 */
  function importDag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    commit(
      () => createDemoDag(JSON.parse(importText) as DemoDag),
      "已载入 DAG JSON",
    );
  }

  /** 将当前结构和节点/边数据导出为 JSON 文件。 */
  function exportDag() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "goalsplit-dag.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="dag-workbench">
      <header className="app-header">
        <div className="brand-mark">
          G<span>·</span>
        </div>
        <div>
          <strong>GoalSplit</strong>
          <small>DAG 数据工作台</small>
        </div>
        <span className="header-divider" />
        <span className="header-caption">结构与数据，独立可复用</span>
        <span className="header-status">● 本地草稿已启用</span>
      </header>
      <main className="page-content">
        <section className="intro">
          <div>
            <div className="eyebrow">DAG / GRAPH WORKSPACE</div>
            <h1>把任务关系，变成可操作的图</h1>
            <p>
              节点和边都携带独立数据。每次修改先验证无环与引用，再生成新的图结构。
            </p>
          </div>
          <div className="intro-actions">
            <button onClick={() => openMode("import")}>导入 JSON</button>
            <button onClick={exportDag}>导出 JSON</button>
          </div>
        </section>
        <section className="stats" aria-label="图概览">
          <div>
            <span>节点</span>
            <strong>{graph.nodes.length.toString().padStart(2, "0")}</strong>
            <small>可绑定业务数据</small>
          </div>
          <div>
            <span>边</span>
            <strong>{graph.edges.length.toString().padStart(2, "0")}</strong>
            <small>独立 ID 与数据</small>
          </div>
          <div>
            <span>拓扑顺序</span>
            <strong className="stat-text">
              {topologicalOrder(graph).join(" → ") || "空图"}
            </strong>
            <small>更新时自动校验 DAG</small>
          </div>
        </section>
        <section className="workspace">
          <div className="graph-column">
            <div className="section-heading">
              <div>
                <small>GRAPH CANVAS</small>
                <h2>图结构</h2>
              </div>
              <div className="graph-actions">
                <button onClick={() => openMode("node")}>＋ 节点</button>
                <button className="primary" onClick={() => openMode("edge")}>
                  ＋ 连接
                </button>
              </div>
            </div>
            <div className="canvas-wrap">
              {graph.nodes.length ? (
                <DagView
                  graph={graph}
                  nodeLabel={labelOf}
                  edgeLabel={labelOf}
                  selected={selected}
                  onNodeSelect={(node) => {
                    setSelected({ type: "node", id: node.id });
                    setMode(null);
                    setError("");
                  }}
                  onEdgeSelect={(edge) => {
                    setSelected({ type: "edge", id: edge.id });
                    setSource(edge.source);
                    setTarget(edge.target);
                    setMode(null);
                    setError("");
                  }}
                />
              ) : (
                <div className="canvas-empty">空图 · 点击「＋ 节点」开始</div>
              )}
            </div>
            <div className="canvas-footer">
              <span>点击节点或连线查看绑定数据</span>
              <span>拖拽画布平移 · 滚轮缩放</span>
            </div>
          </div>
          <aside className="inspector">
            <div className="section-heading">
              <div>
                <small>INSPECTOR</small>
                <h2>
                  {mode === "node"
                    ? "新增节点"
                    : mode === "edge"
                      ? "新增连接"
                      : mode === "import"
                        ? "导入图"
                        : current
                          ? selected?.type === "node"
                            ? "节点数据"
                            : "边数据"
                          : "结构详情"}
                </h2>
              </div>
              {(mode || selected) && (
                <button
                  className="icon-button"
                  aria-label="关闭详情"
                  onClick={() => {
                    setMode(null);
                    setSelected(null);
                    setError("");
                  }}
                >
                  ×
                </button>
              )}
            </div>
            {error && (
              <p className="message error" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="message success" role="status">
                {notice}
              </p>
            )}
            {mode === "import" ? (
              <form className="editor-form" onSubmit={importDag}>
                <label>
                  完整 DAG JSON
                  <textarea
                    rows={14}
                    value={importText}
                    onChange={(event) => setImportText(event.target.value)}
                    placeholder={'{ "nodes": [], "edges": [] }'}
                    required
                  />
                </label>
                <p className="hint">
                  导入前验证节点、边和环；失败时保留当前图。
                </p>
                <button className="primary" type="submit">
                  验证并载入
                </button>
              </form>
            ) : mode ? (
              <form className="editor-form" onSubmit={addItem}>
                <label>
                  {mode === "node" ? "节点 ID" : "边 ID"}
                  <input
                    value={id}
                    onChange={(event) => setId(event.target.value)}
                    placeholder={
                      mode === "node" ? "例如：deploy" : "例如：review-deploy"
                    }
                    required
                  />
                </label>
                {mode === "edge" && (
                  <>
                    <label>
                      起点
                      <select
                        value={source}
                        onChange={(event) => setSource(event.target.value)}
                        required
                      >
                        <option value="">选择节点</option>
                        {graph.nodes.map((node) => (
                          <option key={node.id} value={node.id}>
                            {labelOf(node)} · {node.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      终点
                      <select
                        value={target}
                        onChange={(event) => setTarget(event.target.value)}
                        required
                      >
                        <option value="">选择节点</option>
                        {graph.nodes.map((node) => (
                          <option key={node.id} value={node.id}>
                            {labelOf(node)} · {node.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <label>
                  绑定数据 · JSON
                  <textarea
                    rows={9}
                    value={dataText}
                    onChange={(event) => setDataText(event.target.value)}
                    required
                  />
                </label>
                <p className="hint">
                  {mode === "edge"
                    ? "连接不得形成环；边数据与节点数据相互独立。"
                    : "数据由宿主解释，图内核仅维护结构。"}
                </p>
                <button className="primary" type="submit">
                  添加{mode === "node" ? "节点" : "连接"}
                </button>
              </form>
            ) : current ? (
              <form className="editor-form" onSubmit={saveData}>
                <div className="detail-row">
                  <span>ID</span>
                  <code>{current.id}</code>
                </div>
                {currentEdge && (
                  <>
                    <label>
                      起点
                      <select
                        value={source}
                        onChange={(event) => setSource(event.target.value)}
                        required
                      >
                        {graph.nodes.map((node) => (
                          <option key={node.id} value={node.id}>
                            {labelOf(node)} · {node.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      终点
                      <select
                        value={target}
                        onChange={(event) => setTarget(event.target.value)}
                        required
                      >
                        {graph.nodes.map((node) => (
                          <option key={node.id} value={node.id}>
                            {labelOf(node)} · {node.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <label>
                  绑定数据 · JSON
                  <textarea
                    rows={11}
                    value={dataText}
                    onChange={(event) => setDataText(event.target.value)}
                    required
                  />
                </label>
                <div className="editor-actions">
                  <button className="primary" type="submit">
                    保存修改
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={deleteSelected}
                  >
                    删除
                  </button>
                </div>
              </form>
            ) : (
              <div className="inspector-empty">
                <div className="empty-icon">◇</div>
                <h3>选择一个元素</h3>
                <p>
                  点击图中的节点或连接，查看和修改其数据。也可以从上方添加新元素。
                </p>
                <div className="empty-note">
                  每次操作都会生成新图，原结构不会被直接修改。
                </div>
              </div>
            )}
          </aside>
        </section>
        <section className="data-strip">
          <div>
            <small>DATA MODEL</small>
            <h2>同一张图，两种数据</h2>
            <p>
              节点保存业务实体，边保存实体间的关系信息。下游系统通过稳定 ID
              读取所需数据。
            </p>
          </div>
          <pre>{`type Dag<N, E> = {\n  nodes: { id: string; data: N }[];\n  edges: { id: string; source: string; target: string; data: E }[];\n}`}</pre>
        </section>
      </main>
    </div>
  );
}
