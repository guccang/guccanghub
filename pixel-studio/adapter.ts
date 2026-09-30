import type { AgentNodeStatus, AgentRunSnapshot } from '../agents-dag-context/types.js';
import { studioCharacters, type StudioSnapshot, type StudioStatus, type StudioActor, type StudioHandoff } from './types.js';
const stateMap: Record<AgentNodeStatus, StudioStatus> = { READY: 'idle', BLOCKED: 'blocked', RUNNING: 'working', SUCCEEDED: 'success', FAILED: 'error', PAUSED: 'paused', UNKNOWN: 'unknown' };
const priority: StudioStatus[] = ['working', 'unknown', 'error', 'paused', 'blocked', 'idle', 'success'];
export interface StudioAdapterOptions {
  readonly revision: number;
  readonly actors?: readonly Pick<StudioActor, 'id' | 'name' | 'character' | 'isLead'>[];
  readonly handoffs?: readonly StudioHandoff[];
}
/** 一个真实 agentId 对应一个人物，多节点状态按优先级汇总。 */
export function agentRunToStudio(run: AgentRunSnapshot, options: StudioAdapterOptions): StudioSnapshot {
  const ids = [...new Set(run.graph.nodes.map(node => node.data.agentId))];
  const tasks = run.graph.nodes.map(node => ({
    id: node.id, title: node.data.instruction, actorId: node.data.agentId,
    status: stateMap[run.states[node.id].status],
  }));
  return {
    version: 1, runId: run.runId, title: run.goal.objective, revision: options.revision,
    actors: ids.map((id, index) => {
      const identity = options.actors?.find(actor => actor.id === id);
      const owned = tasks.filter(task => task.actorId === id);
      const status = priority.find(value => owned.some(task => task.status === value))!;
      return { id, name: identity?.name ?? id, character: identity?.character ?? studioCharacters[index % studioCharacters.length], isLead: identity?.isLead ?? false, status, activity: owned.find(task => task.status === status)?.title ?? '' };
    }),
    tasks, handoffs: options.handoffs ?? [],
  };
}
