import type { Context } from '@cordisjs/core';
import type { ManagedDag } from '../cordis/dag.js';
import { studioCharacters, type StudioSnapshot, type StudioStatus } from './types.js';
import './service.js';
const statuses: Record<string, StudioStatus> = { READY: 'idle', BLOCKED: 'blocked', RUNNING: 'working', SUCCEEDED: 'success', FAILED: 'error', PAUSED: 'paused', UNKNOWN: 'unknown' };
const priority: StudioStatus[] = ['working', 'unknown', 'error', 'paused', 'blocked', 'idle', 'success'];
/** 编辑器图投影；缺少状态的节点只显示为待执行。 */
export function dagToStudio(graph: ManagedDag, revision: number): StudioSnapshot {
  const tasks = graph.nodes.map(node => ({
    id: node.id,
    title: typeof node.data.label === 'string' && node.data.label.trim() ? node.data.label : typeof node.data.instruction === 'string' && node.data.instruction.trim() ? node.data.instruction : node.id,
    actorId: typeof node.data.agentId === 'string' && node.data.agentId.trim() ? node.data.agentId : node.id,
    status: statuses[String(node.data.status)] ?? 'idle',
  }));
  const ids = [...new Set(tasks.map(task => task.actorId))];
  return {
    version: 1, runId: 'dag-editor', title: '当前 DAG 的节点与任务', revision,
    actors: ids.map((id, index) => {
      const owned = tasks.filter(task => task.actorId === id);
      const status = priority.find(value => owned.some(task => task.status === value))!;
      return { id, name: id, character: studioCharacters[index % studioCharacters.length], status, activity: owned.find(task => task.status === status)?.title ?? '' };
    }), tasks, handoffs: [],
  };
}
/** 可选投影插件；接入实际 context 数据时改用宿主发布快照。 */
export const dagStudioBridgePlugin = {
  name: 'dag-pixel-studio-bridge',
  inject: ['dagGraph', 'pixelStudio'],
  apply(ctx: Context) {
    let revision = 0;
    const publish = () => { ctx.pixelStudio.publish(dagToStudio(ctx.dagGraph.getSnapshot(), ++revision)); };
    publish();
    const unsubscribe = ctx.dagGraph.subscribe(publish);
    ctx.on('dispose', unsubscribe);
  },
};
