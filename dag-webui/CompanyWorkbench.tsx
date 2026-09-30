import { useState, useSyncExternalStore, type FormEvent } from 'react';
import type { CompanyClientService } from '../company/client.js';
import type { DagGraphService } from '../cordis/dag.js';
import type { StudioDisplayPort } from '../pixel-studio/types.js';
import { PixelStudio } from '../pixel-studio/PixelStudio.js';
import { DagView } from './DagView.js';
const title = (value: unknown): string => { const text = String(value); return text.length > 48 ? text.slice(0, 48) + '…' : text; };
const labels: Record<string, string> = { PLANNING: '正在拆解', RUNNING: '正在执行', SUCCEEDED: '已完成', FAILED: '执行失败', CANCELLED: '已停止', READY: '待执行', BLOCKED: '等待上游', PAUSED: '已暂停', UNKNOWN: '待确认' };
/** 真实任务面板：图只读，节点结果来自公司服务持久化的 context。 */
export function CompanyWorkbench({ client, service, studio }: { client: CompanyClientService; service: DagGraphService; studio: StudioDisplayPort }) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const graph = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const [objective, setObjective] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<{ runId: string; nodeId: string } | null>(null);
  const current = state.current;
  const active = state.tasks.some(task => ['PLANNING', 'RUNNING'].includes(task.status));
  const selected = selection?.runId === current?.runId ? selection?.nodeId ?? null : null;
  const node = current?.run?.graph.nodes.find(item => item.id === selected);
  const feedback = node ? current?.feedback[node.id] : undefined;
  const complete = current?.run ? Object.values(current.run.states).filter(item => item.status === 'SUCCEEDED').length : 0;
  async function submit(event: FormEvent) {
    event.preventDefault(); setPending(true); setError('');
    try { await client.submit(objective); setObjective(''); setSelection(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  async function cancel() {
    setPending(true); setError('');
    try { await client.cancel(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  return <div className="company-workbench">
    <header className="company-header"><a className="company-brand" href="/">G<span>·</span> 公司工作台</a><span className={`company-connection ${state.connected ? 'connected' : ''}`}>{state.connected ? '服务已连接' : '服务未连接'}</span><a href="/?mode=editor">打开 DAG 编辑器 ↗</a></header>
    <main className="company-main">
      <section className="company-dispatch"><div><p className="company-caption">任务委派</p><h1>交给团队，跟进每一步。</h1><p>输入目标，团队会拆解任务、依次完成节点，并把产物交给下一位同事。</p></div>
        <form onSubmit={event => { void submit(event); }}><label htmlFor="company-objective">这次需要团队完成什么？</label><textarea id="company-objective" value={objective} onChange={event => setObjective(event.target.value)} maxLength={16000} required placeholder="例如：分析当前项目，制定改进方案并完成一个优先级最高的改动。" rows={3} /><div className="company-form-footer"><small>{active ? '团队正在处理任务，完成后可继续委派。' : '填写目标、约束和希望交付的内容。'}</small><button className="company-primary" type="submit" disabled={!state.connected || active || pending || !objective.trim()}>{pending ? '正在提交…' : '开始任务 →'}</button></div></form>
      </section>
      {(state.error || error) && <div className="company-alert" role="alert">{error || state.error}</div>}
      <div className="company-workspace"><aside className="company-history"><h2>任务记录 <span>{state.tasks.length}</span></h2>{state.tasks.length ? state.tasks.map(task => <button key={task.runId} className={task.runId === current?.runId ? 'selected' : ''} onClick={() => { client.select(task.runId); setSelection(null); }}><span>{task.objective}</span><small>{labels[task.status]} · {new Date(task.createdAt).toLocaleTimeString()}</small></button>) : <p>提交第一个任务后，拆解过程和交付结果会显示在这里。</p>}</aside>
        <section className="company-task"><div className="company-task-heading"><div><p className="company-caption">{current ? labels[current.status] : '等待委派'}</p><h2>{current?.objective ?? '团队已就位'}</h2></div>{current && <div className="company-task-actions"><span>{complete} / {current.run?.graph.nodes.length ?? '—'} 个节点完成</span>{['PLANNING', 'RUNNING'].includes(current.status) && <button onClick={() => { void cancel(); }} disabled={pending}>停止任务</button>}</div>}</div>
          {current?.error && <div className="company-alert" role="alert">{current.error}</div>}
          <div className="company-graph">{graph.nodes.length ? <DagView graph={graph} nodeClassName={item => `company-node-${String(item.data.status).toLowerCase()}`} nodeLabel={item => `${title(item.data.label)}\n${labels[String(item.data.status)] ?? item.data.status} · ${item.data.agentId}`} selected={selected ? { type: 'node', id: selected } : null} onNodeSelect={item => { if (current) setSelection({ runId: current.runId, nodeId: item.id }); }} /> : <div className="company-empty"><strong>{current?.status === 'PLANNING' ? '负责人正在安排任务…' : '任务从一个目标开始'}</strong><p>{current?.status === 'PLANNING' ? '拆解完成后，这里会显示节点与依赖。' : '提交目标，查看团队的工作路径。'}</p></div>}</div>
          <section className="company-result"><h3>{node ? `节点详情 · ${node.id}` : '节点产物'}</h3>{node ? <><p>{node.data.instruction}</p><p className="company-caption">{labels[current!.run!.states[node.id].status]} · {node.data.agentId}</p>{feedback ? <><p>{feedback.summary}</p>{feedback.status === 'FAILED' && <p role="alert">{feedback.error}</p>}<pre>{JSON.stringify(feedback.output, null, 2)}</pre></> : <p>节点完成后，摘要和结构化产物会显示在这里。</p>}</> : <p>点击图中的节点，查看执行指令、状态与产物。</p>}</section>
          <section className="company-office"><h2>像素办公室 <small>跟随任务进度</small></h2><PixelStudio display={studio} onInteraction={interaction => { if (interaction.type === 'select-actor') { const owned = current?.run?.graph.nodes.filter(item => item.data.agentId === interaction.actorId); const selectedNode = owned?.find(item => current?.run?.states[item.id].status === 'RUNNING') ?? owned?.[0]; if (current && selectedNode) setSelection({ runId: current.runId, nodeId: selectedNode.id }); } }} /></section>
        </section>
      </div>
    </main>
  </div>;
}
