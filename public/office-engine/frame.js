// 显示桥接只响应宿主快照和相机操作，原 GoalHub 引擎保持原样。
const send = value => parent.postMessage(value, location.origin);
let scene, epoch = -1, runId = '', motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
try {
  const { OfficeScene } = await import('./engine.js');
  scene = new OfficeScene(document.getElementById('scene'), actorId => send({ type: 'studio:interaction', interaction: { type: 'select-actor', actorId } }));
  document.getElementById('scene').addEventListener('office:navigate', event => send({ type: 'studio:interaction', interaction: { type: 'navigate', target: event.detail } }));
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== parent) return;
    const message = event.data;
    if (message?.type === 'studio:state') {
      const { snapshot, connected, selectedActorId, connectionEpoch } = message.state;
      if (snapshot) {
        const states = { idle: 'idle', working: 'working', blocked: 'blocked', paused: 'paused', success: 'success', error: 'error', unknown: 'blocked' };
        const actors = snapshot.actors.map(actor => ({ ...actor, kind: 'employee', enabled: true, state: states[actor.status], role: 'developer', effectiveLanguage: 'zh-CN' }));
        // UNKNOWN 只作为阻断显示，不伪装成正在工作。
        scene.setProject({ status: connected ? 'running' : 'paused', tasks: snapshot.tasks.map(task => ({ id: task.id, assignee: task.actorId, status: task.status === 'success' ? 'done' : task.status === 'working' ? 'running' : ['blocked','error','unknown'].includes(task.status) ? 'blocked' : 'todo' })), questions: [] });
        scene.update({ projectId: snapshot.runId, actors, messages: snapshot.handoffs.map(message => ({ id: message.sequence, from: message.from, to: message.to, kind: message.kind === 'completed' ? 'task.completed' : message.kind === 'input-required' ? 'input.required' : 'task.assigned' })) }, epoch !== connectionEpoch || runId !== snapshot.runId);
        epoch = connectionEpoch; runId = snapshot.runId;
      }
      scene.online = connected;
      scene.select(selectedActorId ?? '');
      scene.setVisible(!document.hidden && connected);
    } else if (message?.type === 'studio:command') {
      if (message.command === 'fit') scene.fit();
      if (message.command === 'zoom-in') scene.zoomBy(.15);
      if (message.command === 'zoom-out') scene.zoomBy(-.15);
      if (message.command === 'motion') { motion = !!message.enabled; scene.setMotion(motion); }
    }
  });
  document.addEventListener('visibilitychange', () => scene.setVisible(!document.hidden && scene.online));
  window.addEventListener('pagehide', () => scene.destroy(), { once: true });
  send({ type: 'studio:ready' });
} catch (error) {
  const element = document.getElementById('error');
  element.hidden = false; element.textContent = '场景加载失败，仍可在右侧查看角色与任务。';
  send({ type: 'studio:error', message: error instanceof Error ? error.message : String(error) });
}
