/** 可嵌入的运行台：图、历史快照、节点上下文和数据库事件流。 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { applyNodeChanges, Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import type { PlanVersion, RunSnapshot, RuntimeEvent, TaskRun, TaskSpec } from '../src/types.js';

type ControlsState = { start: boolean; pause: boolean; resume: boolean; interrupt: boolean; rerun: boolean; restart: boolean };
type Summary = Pick<RunSnapshot, 'id' | 'goal' | 'status' | 'createdAt' | 'planVersion'>;
type TaskNode = Node<{ task: TaskSpec; state?: TaskRun; progress?: string; diff?: string }, 'task'>;
const labels: Record<string, string> = { CREATED: '待启动', PLANNING: '拆解目标', RUNNING: '执行中', EVALUATING: '评估中', PAUSING: '等待安全边界', PAUSED: '已暂停', WAITING_INPUT: '等待处理', RECOVERING: '恢复中', SUCCEEDED: '已完成', FAILED: '失败', PENDING: '等待依赖', READY: '就绪', INTERRUPTED: '已中断', UNKNOWN: '待核对', DISPATCHED: '已派发' };
const eventLabels: Record<string, string> = { 'run.created': '创建目标', 'run.started': '启动运行', 'evaluation.started': '评估计划', 'evaluation.decided': '规划决策', 'plan.committed': '更新任务图', 'attempt.dispatched': '派发任务', 'attempt.started': '开始执行', 'attempt.progress': '任务进度', 'attempt.completed': '执行结束', 'run.completed': '目标已完成', 'run.pause_requested': '请求暂停', 'run.drained': '到达安全边界', 'run.resumed': '恢复运行', 'tasks.invalidated': '旧结果失效', 'task.rerun_requested': '请求重跑', 'attempt.unknown': '执行待核对', 'run.recovered': '恢复状态', 'artifact.created': '保存产物', 'run.waiting': '等待处理', 'evaluation.discarded': '重新获取评估快照' };

/** 将状态编码转为面向用户的标签。 */
function statusLabel(value: string): string { return labels[value] ?? value; }
/** 格式化事件时间，保留秒级变化。 */
function timeLabel(value: string): string { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }); }
/** 渲染具有文字与颜色双重提示的状态标签。 */
function Status({ value }: { value: string }) { return <span className={`status status-${value.toLowerCase()}`}><span className="status-dot" />{statusLabel(value)}</span>; }
/** 渲染图节点，输入和输出端点沿水平方向排列。 */
function TaskCard({ data, selected }: NodeProps<TaskNode>) {
  return <div className={`task-card ${selected ? 'selected' : ''} ${data.diff ? 'changed' : ''}`}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <div className="task-card-top"><span className="task-code">{data.task.id}</span>{data.diff && <span className="diff-tag">{data.diff}</span>}</div>
    <strong>{data.task.title}</strong><Status value={data.state?.status ?? 'PENDING'} />
    <div className="task-card-bottom"><span>{data.progress ?? (data.state?.blockedReason ? '依赖尚未满足' : '等待调度')}</span><span>第 {data.state?.generation ?? 1} 代</span></div>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
}
const nodeTypes = { task: TaskCard };

/** 创建节点布局与依赖连线，并标记相邻图版本差异。 */
function buildGraph(snapshot: RunSnapshot | null, selectedTask: string | null, showDiff: boolean) {
  if (!snapshot) return { nodes: [] as TaskNode[], edges: [] };
  const plan = snapshot.plans.find(item => item.version === snapshot.planVersion);
  const previous = snapshot.plans.find(item => item.version === snapshot.planVersion - 1);
  const levels = new Map<string, number>(); const columns = new Map<number, number>();
  const nodes: TaskNode[] = (plan?.graph.tasks ?? []).map(task => {
    const level = task.dependencies.length ? Math.max(...task.dependencies.map(id => levels.get(id) ?? 0)) + 1 : 0;
    levels.set(task.id, level); const row = columns.get(level) ?? 0; columns.set(level, row + 1);
    const state = snapshot.tasks.findLast(item => item.taskId === task.id && item.valid);
    const attempt = snapshot.attempts.find(item => item.id === state?.attemptIds.at(-1));
    const old = previous?.graph.tasks.find(item => item.id === task.id);
    const diff = showDiff && previous ? !old ? '新增' : old.revision !== task.revision ? '修改' : state?.generation && state.generation > 1 ? '结果更新' : undefined : undefined;
    return { id: task.id, type: 'task', selected: selectedTask === task.id,
      position: snapshot.layout[task.id] ?? { x: level * 300 + 40, y: row * 190 + 60 },
      data: { task, state, progress: attempt?.progress?.message, diff }, ariaLabel: `${task.title} ${statusLabel(state?.status ?? 'PENDING')}` };
  });
  const edges = (plan?.graph.tasks ?? []).flatMap(task => task.dependencies.map(id => ({ id: `${id}:${task.id}`, source: id, target: task.id, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, color: '#8292aa' }, style: { stroke: '#8292aa', strokeWidth: 1.5 } })));
  return { nodes, edges };
}

/** 嵌入宿主的可视化面板；apiBase 对应 createRuntimeRouter 的挂载前缀。 */
export function RuntimePanel({ apiBase = '/api' }: { apiBase?: string }) {
  const [runs, setRuns] = useState<Summary[]>([]); const [runId, setRunId] = useState<string | null>(null);
  const [live, setLive] = useState<RunSnapshot | null>(null); const [history, setHistory] = useState<RunSnapshot | null>(null);
  const [controls, setControls] = useState<ControlsState | null>(null); const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [selectedTask, setSelectedTask] = useState<string | null>(null); const [error, setError] = useState('');
  const [connected, setConnected] = useState(false); const [busy, setBusy] = useState(false); const [creating, setCreating] = useState(false);
  const [objective, setObjective] = useState('设计一个可持续迭代的产品上线方案'); const [showDiff, setShowDiff] = useState(true);
  const [detailTab, setDetailTab] = useState('context'); const selectedRef = useRef(runId); selectedRef.current = runId;
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [renderedNodes, setRenderedNodes] = useState<TaskNode[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null); const flowRef = useRef<Pick<ReactFlowInstance<TaskNode>, 'fitView'> | null>(null);
  const display = history ?? live;
  /** 统一解析服务端错误信息。 */
  const request = useCallback(async (path: string, options?: RequestInit) => {
    const response = await fetch(`${apiBase}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
    if (response.status === 204) return null;
    const body = await response.json(); if (!response.ok) throw new Error(body.error ?? '请求失败'); return body;
  }, [apiBase]);
  /** 刷新运行列表，并恢复浏览器上次选择的运行。 */
  const refreshRuns = useCallback(async () => {
    const next: Summary[] = await request('/runs'); setRuns(next);
    setRunId(previous => previous ?? next.find(item => item.id === localStorage.getItem('goalsplit:last-run'))?.id ?? next[0]?.id ?? null);
  }, [request]);
  useEffect(() => { void refreshRuns().catch(error => setError(String(error.message))); }, [refreshRuns]);
  useEffect(() => {
    if (!canvasRef.current) return;
    // 容器变窄时重新适配图，兼容嵌入式布局与移动设备旋转。
    const observer = new ResizeObserver(() => { requestAnimationFrame(() => { void flowRef.current?.fitView({ padding: 0.15 }); }); });
    observer.observe(canvasRef.current); return () => observer.disconnect();
  }, [live?.id]);
  useEffect(() => {
    setLive(null); setHistory(null); setEvents([]); setSelectedTask(null); setControls(null); setConnected(false); setPositions({});
    if (!runId) return;
    localStorage.setItem('goalsplit:last-run', runId);
    let disposed = false; let source: EventSource | undefined; let cursor = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    /** 读取最新快照；切换运行后丢弃旧请求的返回。 */
    const refresh = async () => {
      const body = await request(`/runs/${runId}`);
      if (!disposed) { setLive(body.snapshot); setControls(body.controls); void refreshRuns().catch(() => {}); }
    };
    /** 按序号合并事件，去掉断线续传中的重复内容。 */
    const mergeEvents = (incoming: RuntimeEvent[]) => {
      if (disposed) return;
      setEvents(previous => { const map = new Map(previous.map(event => [event.seq, event])); for (const event of incoming) map.set(event.seq, event); return [...map.values()].sort((a, b) => a.seq - b.seq); });
    };
    /** 从数据库补齐事件缺口，不依赖浏览器连接期间的通知。 */
    const catchUp = async (after: number) => {
      let position = after;
      while (!disposed) { const page: RuntimeEvent[] = await request(`/runs/${runId}/history?after=${position}`); mergeEvents(page); if (!page.length) break; position = page.at(-1)!.seq; if (page.length < 1000) break; }
      cursor = Math.max(cursor, position);
    };
    void (async () => {
      await refresh(); await catchUp(0); if (disposed) return;
      source = new EventSource(`${apiBase}/runs/${runId}/events?after=${cursor}`);
      source.onopen = () => { if (!disposed) { setConnected(true); setError(previous => previous === 'Failed to fetch' ? '' : previous); void refresh().catch(() => {}); } }; source.onerror = () => { if (!disposed) setConnected(false); };
      source.addEventListener('runtime', event => {
        const item: RuntimeEvent = JSON.parse((event as MessageEvent).data); if (item.seq <= cursor || disposed) return;
        if (item.seq > cursor + 1) void catchUp(cursor).catch(error => setError(error.message));
        else { cursor = item.seq; mergeEvents([item]); }
        clearTimeout(timer); timer = setTimeout(() => { void refresh().catch(error => setError(error.message)); }, 50);
      });
      await refresh();
    })().catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; source?.close(); clearTimeout(timer); };
  }, [runId, request, apiBase, refreshRuns]);

  /** 创建运行，但将启动权留给明确的执行操作。 */
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const body = await request('/runs', { method: 'POST', body: JSON.stringify({ goal: { objective, constraints: [], acceptance: ['所有必需任务完成并提供可核对产物'] }, commandId: crypto.randomUUID() }) }); setRunId(body.id); setCreating(false); await refreshRuns(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  /** 发送带幂等键的控制命令，历史查看期间禁止执行。 */
  async function command(action: string, taskId?: string) {
    if (!runId || history) return; setBusy(true); setError('');
    try { const body = await request(`/runs/${runId}/commands`, { method: 'POST', body: JSON.stringify({ action, taskId, commandId: crypto.randomUUID() }) });
      if (body.id) setRunId(body.id); else { setLive(body.snapshot); setControls(body.controls); } await refreshRuns();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  /** 从持久化快照读取历史，绝不派发执行或修改任务。 */
  async function viewHistory(seq: number) {
    const selected = runId;
    try { const body = await request(`/runs/${runId}?atSeq=${seq}`); if (selectedRef.current === selected) setHistory(body.snapshot); }
    catch (error) { setError((error as Error).message); }
  }
  /** 将图版本定位到完整事务的最后事件，避免展示半个事务。 */
  function selectVersion(value: string) {
    if (value === 'live') { setHistory(null); return; }
    const version = Number(value); const event = events.find(item => item.type === 'plan.committed' && (item.data as { version?: number }).version === version);
    const seq = event ? Math.max(...events.filter(item => item.stateRevision === event.stateRevision).map(item => item.seq)) : 1;
    void viewHistory(seq);
  }
  /** 保存画布坐标；历史视图禁止修改。 */
  async function savePosition(id: string, position: { x: number; y: number }) {
    if (!live || history) return;
    try { await request(`/runs/${live.id}/layout`, { method: 'PUT', body: JSON.stringify({ ...live.layout, ...positions, [id]: position }) }); }
    catch (error) { setError((error as Error).message); }
  }

  const graph = useMemo(() => {
    const value = buildGraph(display, selectedTask, showDiff);
    if (!history) for (const node of value.nodes) if (positions[node.id]) node.position = positions[node.id];
    return value;
  }, [display, selectedTask, showDiff, history, positions]);
  useEffect(() => {
    // 保留 React Flow 的测量结果，避免状态刷新后节点重新变为不可见。
    setRenderedNodes(previous => graph.nodes.map(node => {
      const existing = previous.find(item => item.id === node.id);
      return { ...existing, ...node, ...(existing?.dragging ? { position: existing.position } : {}) };
    }));
  }, [graph.nodes]);
  const plan = display?.plans.find(item => item.version === display.planVersion);
  const selectedSpec = plan?.graph.tasks.find(task => task.id === selectedTask);
  const selectedState = display?.tasks.findLast(task => task.taskId === selectedTask && task.valid);
  const attempts = display?.attempts.filter(attempt => attempt.taskId === selectedTask) ?? [];
  const activeTasks = display?.tasks.filter(task => task.valid) ?? [];
  const previousPlan: PlanVersion | undefined = display?.plans.find(item => item.version === display.planVersion - 1);
  const removedTasks = previousPlan?.graph.tasks.filter(task => !plan?.graph.tasks.some(item => item.id === task.id)) ?? [];
  const importantEvents = events.filter(event => !['attempt.handle_saved', 'attempt.checkpoint_saved', 'attempt.progress', 'layout.saved', 'task.ready', 'state.updated'].includes(event.type));

  return <div className="goalsplit-panel">
    <aside className="sidebar">
      <div className="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 6h18M7 6v20h18M7 16h18"/><circle cx="7" cy="6" r="3"/><circle cx="25" cy="6" r="3"/><circle cx="25" cy="16" r="3"/><circle cx="25" cy="26" r="3"/></svg><div><strong>GoalSplit</strong><span>目标运行台</span></div></div>
      <button className="new-run" onClick={() => setCreating(true)}>＋ 新建目标</button>
      <div className="sidebar-label">运行记录 <span>{runs.length}</span></div>
      <nav aria-label="运行记录">{runs.map(run => <button key={run.id} className={`run-item ${run.id === runId ? 'active' : ''}`} onClick={() => setRunId(run.id)}><span>{run.goal.objective}</span><div><Status value={run.status}/><small>v{run.planVersion}</small></div></button>)}{!runs.length && <p className="quiet">还没有运行记录</p>}</nav>
      <div className="sidebar-foot"><span className={`connection-dot ${connected ? 'online' : ''}`}/>{connected ? '状态实时同步' : runId ? '正在连接或重连' : '等待创建目标'}<small>单机运行 · SQLite 持久化</small></div>
    </aside>
    <main>
      <header className="topbar"><span>工作空间 <span className="slash">/</span> {live ? '目标详情' : '开始一个目标'}</span><span className="demo-badge">模拟适配器演示</span></header>
      {error && <div role="alert" className="error-banner"><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}
      {!runId ? <div className="welcome"><div className="welcome-graphic"><span>目标</span><i/><span>任务</span><i/><span>成果</span></div><h1>给目标一条清晰的路径</h1><p>拆解依赖，观察执行，在每次反馈后调整计划。<br/>这里的每一次变化都会留下记录。</p><form onSubmit={create}><label htmlFor="first-goal">你希望完成什么？</label><textarea id="first-goal" value={objective} onChange={event => setObjective(event.target.value)} required rows={3}/><button className="primary" disabled={busy || !objective.trim()}>创建运行</button></form><small>演示使用确定性的模拟任务，无需配置模型账号。</small></div>
      : !live ? <div className="loading" role="status">正在读取运行快照…</div> : <>
        <section className="run-header"><div><div className="run-heading"><h1>{live.goal.objective}</h1><Status value={display?.status ?? live.status}/></div><p>{activeTasks.filter(task => task.status === 'SUCCEEDED').length} / {activeTasks.length} 个任务完成<span>计划 v{display?.planVersion ?? 0}</span><span>{history ? '历史快照' : '当前状态'}</span></p></div>
          <div className="actions"><button className="primary" disabled={busy || !!history || !(controls?.start || controls?.resume)} onClick={() => void command(controls?.start ? 'start' : 'resume')}>{controls?.start ? '执行目标' : '恢复执行'}</button><button disabled={busy || !!history || !controls?.pause} onClick={() => void command('pause')}>暂停</button><button disabled={busy || !!history || !controls?.interrupt} onClick={() => void command('interrupt')}>中断</button><button disabled={busy || !!history || !controls?.restart} onClick={() => void command('restart')}>整体重跑</button></div>
        </section>
        {display?.reason && <div className={`reason-bar ${display.status === 'WAITING_INPUT' ? 'attention' : ''}`}>{display.reason}</div>}
        {live.status === 'PAUSING' && <div className="reason-bar">已停止派发新任务，等待当前调用结束并保存结果。</div>}
        {history && <div className="history-bar">正在查看事件 #{history.lastEventSeq} 的历史快照，操作已禁用。<button onClick={() => setHistory(null)}>返回实时状态</button></div>}
        <div className="workspace"><section className="graph-pane"><div className="pane-toolbar"><strong>任务依赖图</strong><div><label className="check"><input type="checkbox" checked={showDiff} onChange={event => setShowDiff(event.target.checked)}/>显示版本差异</label><select aria-label="图版本" value={history ? String(history.planVersion) : 'live'} onChange={event => selectVersion(event.target.value)}><option value="live">当前版本（实时）</option>{live.plans.map(plan => <option key={plan.version} value={plan.version}>v{plan.version} · 提交时快照</option>)}</select></div></div>
          <div className="graph-canvas" ref={canvasRef}>{graph.nodes.length ? <ReactFlow key={`${runId}-${display?.planVersion}`} onInit={instance => { flowRef.current = instance; }} nodes={renderedNodes} edges={graph.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15 }} minZoom={0.3} maxZoom={1.5} nodesConnectable={false} nodesDraggable={!history} onNodesChange={changes => setRenderedNodes(previous => applyNodeChanges(changes, previous))} elementsSelectable onNodeClick={(_event, node) => setSelectedTask(node.id)} onNodeDragStop={(_event, node) => { setPositions(previous => ({ ...previous, [node.id]: node.position })); void savePosition(node.id, node.position); }} deleteKeyCode={null}><Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d3dce8"/><Controls showInteractive={false}/></ReactFlow> : <div className="graph-empty"><div className="empty-symbol">◇</div><h2>{live.status === 'PLANNING' ? '正在拆解目标' : '计划从这里开始'}</h2><p>执行目标后，规划器将返回第一版任务图。</p></div>}</div>
          <div className="graph-caption"><span>{plan?.reason ?? '每个节点管理依赖与上下文，执行由宿主提供。'}</span>{showDiff && removedTasks.length > 0 && <span className="removed">已移除：{removedTasks.map(task => task.title).join('、')}</span>}</div>
        </section>
        <aside className="inspector"><div className="pane-toolbar"><strong>节点详情</strong>{selectedState && <small>定义 r{selectedState.specRevision}</small>}</div>
          {!selectedSpec ? <div className="inspector-empty"><span>◎</span><h3>查看任务的来龙去脉</h3><p>选择图中的节点，查看依赖输入、执行历史与产物。</p></div> : <><div className="inspector-heading"><small>{selectedSpec.id}</small><h2>{selectedSpec.title}</h2><Status value={selectedState?.status ?? 'PENDING'}/>{selectedState?.blockedReason && <p>{selectedState.blockedReason}</p>}<button disabled={busy || !!history || !controls?.rerun || selectedState?.status === 'UNKNOWN'} onClick={() => void command('rerun', selectedSpec.id)}>重跑节点及下游</button></div>
          <div className="tabs" role="tablist" aria-label="节点信息">{[['context', '上下文'], ['attempts', `执行 (${attempts.length})`], ['artifacts', '产物']].map(([id, label]) => <button role="tab" aria-selected={detailTab === id} key={id} onClick={() => setDetailTab(id)}>{label}</button>)}</div>
          <div className="inspector-content">{detailTab === 'context' && <><h3>任务定义</h3><p>{selectedSpec.description || '按目标约束完成当前任务，并输出可验收结果。'}</p><h3>依赖输入</h3>{selectedSpec.dependencies.length ? selectedSpec.dependencies.map(id => <button className="dependency-link" key={id} onClick={() => setSelectedTask(id)}>{plan?.graph.tasks.find(task => task.id === id)?.title} <span>↗</span></button>) : <p className="quiet">直接来自目标定义</p>}<h3>冻结上下文</h3><pre>{JSON.stringify(attempts.at(-1)?.input ?? { goal: live.goal, task: selectedSpec }, null, 2)}</pre></>}
          {detailTab === 'attempts' && <>{!attempts.length && <p className="quiet">尚未执行</p>}{attempts.slice().reverse().map(attempt => <article className="attempt" key={attempt.id}><div><Status value={attempt.status}/><small>第 {attempt.generation} 代</small></div><p>{timeLabel(attempt.startedAt)}{attempt.endedAt && ` — ${timeLabel(attempt.endedAt)}`}</p><code>{attempt.id.slice(0, 12)}</code>{attempt.error && <p className="error-text">{attempt.error}</p>}{attempt.resumedFrom && <p>从检查点恢复</p>}{attempt.checkpoint !== undefined && <details><summary>检查点</summary><pre>{JSON.stringify(attempt.checkpoint, null, 2)}</pre></details>}{attempt.result && <details><summary>执行结果</summary><pre>{JSON.stringify(attempt.result.output, null, 2)}</pre></details>}</article>)}</>}
          {detailTab === 'artifacts' && <>{!display?.artifacts.some(artifact => attempts.some(attempt => attempt.id === artifact.attemptId)) && <p className="quiet">尚无产物</p>}{display?.artifacts.filter(artifact => attempts.some(attempt => attempt.id === artifact.attemptId)).map(artifact => <a className="artifact-link" key={artifact.id} href={`${apiBase}/runs/${runId}/artifacts/${artifact.id}`} download><strong>{artifact.name}</strong><span>{artifact.size} 字节 {selectedState?.artifactIds.includes(artifact.id) ? '· 当前结果' : '· 历史产物'}</span></a>)}</>}
          </div></>}
        </aside></div>
        <section className="timeline"><div className="pane-toolbar"><strong>运行时间线 <span className="count">{importantEvents.length}</span></strong><span>点击事件查看当时状态</span></div><div className="event-list">{importantEvents.slice().reverse().map(event => <button className={`event-row ${history?.lastEventSeq === event.seq ? 'active' : ''}`} key={event.seq} onClick={() => void viewHistory(Math.max(...events.filter(item => item.stateRevision === event.stateRevision).map(item => item.seq)))}><time>{timeLabel(event.at)}</time><span className={`event-mark ${event.type.includes('completed') ? 'done' : ''}`}/><strong>{eventLabels[event.type] ?? event.type}</strong><span className="event-description">{(event.data as { reason?: string }).reason ?? (event.data as { taskId?: string }).taskId ?? ''}</span><small>#{event.seq}</small></button>)}</div></section>
      </>}
    </main>
    {creating && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title"><div className="modal-heading"><h2 id="create-title">新建目标</h2><button aria-label="关闭新建目标" onClick={() => setCreating(false)}>×</button></div><form onSubmit={create}><label htmlFor="new-goal">你希望完成什么？</label><textarea id="new-goal" autoFocus rows={4} required value={objective} onChange={event => setObjective(event.target.value)}/><p className="quiet">创建后可以启动执行，随时暂停并查看完整历史。</p><button className="primary" disabled={busy || !objective.trim()}>创建运行</button></form></section></div>}
  </div>;
}




