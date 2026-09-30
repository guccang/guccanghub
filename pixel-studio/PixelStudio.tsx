import { serviceDefaults } from '../cordis/config.js';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { StudioDisplayPort, StudioInteraction, StudioStatus } from './types.js';
export const studioStatusLabels: Record<StudioStatus, string> = { idle: '待执行', working: '执行中', blocked: '阻塞', paused: '暂停', success: '已完成', error: '失败', unknown: '结果待确认' };
export interface PixelStudioProps {
  readonly display: StudioDisplayPort;
  /** 与宿主同源的静态场景入口。 */
  readonly frameUrl?: string;
  readonly onInteraction?: (interaction: StudioInteraction) => void;
}
/** iframe 隔离上游引擎的单例状态，支持多个工作室实例。 */
export function PixelStudio({ display, frameUrl = serviceDefaults.pixelStudio.frameUrl, onInteraction }: PixelStudioProps) {
  const state = useSyncExternalStore(display.subscribe, display.getSnapshot, display.getSnapshot);
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(state);
  latest.current = state;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [motion, setMotion] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const snapshot = state.snapshot;
  const selected = snapshot?.actors.find(actor => actor.id === state.selectedActorId);
  function send(value: unknown) { frame.current?.contentWindow?.postMessage(value, location.origin); }
  useEffect(() => {
    const url = new URL(frameUrl, location.href);
    if (url.origin !== location.origin) { setError('场景资源必须与页面同源'); return; }
    const listener = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'studio:ready') {
        setReady(true); setError('');
        send({ type: 'studio:state', state: latest.current });
      } else if (event.data?.type === 'studio:error') {
        setError('场景不可用，可通过角色列表查看状态');
      } else if (event.data?.type === 'studio:interaction') {
        const interaction: StudioInteraction = event.data.interaction;
        if (interaction?.type === 'select-actor') {
          if (!latest.current.snapshot?.actors.some(actor => actor.id === interaction.actorId)) return;
          display.selectActor(interaction.actorId);
        } else if (interaction?.type !== 'navigate' || typeof interaction.target !== 'string') return;
        onInteraction?.(interaction);
      }
    };
    window.addEventListener('message', listener);
    return () => { window.removeEventListener('message', listener); };
  }, [display, frameUrl, onInteraction]);
  useEffect(() => { if (ready) send({ type: 'studio:state', state }); }, [state, ready]);
  useEffect(() => { if (ready) send({ type: 'studio:command', command: 'motion', enabled: motion }); }, [motion, ready]);
  return <section className="pixel-studio" aria-label="像素工作室">
    <header className="studio-header">
      <div><span className="studio-eyebrow">PIXEL STUDIO</span><h2>像素工作室</h2><p>{snapshot?.title ?? '等待显示数据'}</p></div>
      <span className={`studio-connection ${state.connected ? 'connected' : ''}`}>{state.connected ? '快照已同步' : snapshot ? '连接中断 · 保留上次状态' : '等待显示数据'}</span>
    </header>
    <div className="studio-body">
      <div className="studio-stage">
        <div className="studio-toolbar" aria-label="场景控制">
          <button disabled={!ready} onClick={() => send({ type: 'studio:command', command: 'fit' })}>全景</button>
          <button disabled={!ready} aria-label="放大像素场景" onClick={() => send({ type: 'studio:command', command: 'zoom-in' })}>＋</button>
          <button disabled={!ready} aria-label="缩小像素场景" onClick={() => send({ type: 'studio:command', command: 'zoom-out' })}>－</button>
          <button aria-pressed={!motion} onClick={() => setMotion(value => !value)}>减少动态</button>
        </div>
        <iframe ref={frame} src={frameUrl} title="像素办公室地图" className="studio-frame" />
        {!ready && <p role="status" className="studio-loading">{error || '正在加载像素场景…'}</p>}
        <p className="studio-note">人物状态来自显示快照；散步、咖啡等环境动画不代表任务执行。</p>
      </div>
      <aside className="studio-inspector">
        <h3>角色 <span>{snapshot?.actors.length ?? 0}</span></h3>
        {!snapshot?.actors.length && <p>图中新增节点后，将显示对应角色。</p>}
        <div className="studio-roster">{snapshot?.actors.map(actor => <button key={actor.id} aria-pressed={selected?.id === actor.id} onClick={() => { display.selectActor(actor.id); onInteraction?.({ type: 'select-actor', actorId: actor.id }); }}><span>{actor.name}</span><small className={`studio-state ${actor.status}`}>{studioStatusLabels[actor.status]}</small></button>)}</div>
        {selected ? <div className="studio-details"><h3>{selected.name}</h3><p>{selected.activity || '暂无活动'}</p><ul>{snapshot?.tasks.filter(task => task.actorId === selected.id).map(task => <li key={task.id}><span>{task.title}</span><small>{studioStatusLabels[task.status]}</small></li>)}</ul></div> : <p className="studio-hint">选择人物或角色列表，查看绑定的任务。</p>}
      </aside>
    </div>
    <footer className="studio-credit">场景：<a href="https://github.com/guccang/goalhub">GoalHub</a> / <a href="https://github.com/chaitanyagiri/munder-difflin">Munder Difflin</a> · 像素素材：<a href="https://limezu.itch.io/">LimeZu</a> · <a href="/office-engine/LICENSE.txt">代码许可</a> · <a href="/office-engine/ASSET-LICENSE.txt">素材许可</a></footer>
  </section>;
}
