import { studioCharacters, type StudioSnapshot } from './types.js';
const statuses = ['idle', 'working', 'blocked', 'paused', 'success', 'error', 'unknown'];
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('显示数据必须是对象');
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('显示标识和文字必须是非空字符串');
}
function integer(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('显示版本和事件序号必须是非负安全整数');
}
/** 传输边界校验，防止损坏快照进入场景。 */
export function validateStudioSnapshot(value: unknown): asserts value is StudioSnapshot {
  object(value);
  if (value.version !== 1) throw new TypeError('不支持的像素工作室协议版本');
  text(value.runId); text(value.title); integer(value.revision);
  if (!Array.isArray(value.actors) || !Array.isArray(value.tasks) || !Array.isArray(value.handoffs)) throw new TypeError('角色、任务和交接必须是数组');
  const actorIds = new Set<string>();
  for (const actor of value.actors) {
    object(actor); text(actor.id); text(actor.name);
    if (actorIds.has(actor.id) || actor.id === 'human') throw new TypeError('角色 ID 重复或使用了 human 保留标识');
    actorIds.add(actor.id);
    if (!studioCharacters.includes(actor.character as typeof studioCharacters[number]) || !statuses.includes(String(actor.status))) throw new TypeError('角色形象或状态无效');
    if (typeof actor.activity !== 'string' || (actor.isLead !== undefined && typeof actor.isLead !== 'boolean')) throw new TypeError('角色活动或负责人标记无效');
  }
  if (value.actors.filter(actor => actor.isLead).length > 1) throw new TypeError('最多指定一名负责人');
  const taskIds = new Set<string>();
  for (const task of value.tasks) {
    object(task); text(task.id); text(task.title);
    if (taskIds.has(task.id) || !actorIds.has(String(task.actorId)) || !statuses.includes(String(task.status))) throw new TypeError('任务 ID、角色引用或状态无效');
    taskIds.add(task.id);
  }
  let sequence = -1;
  for (const handoff of value.handoffs) {
    object(handoff); integer(handoff.sequence);
    if (handoff.sequence <= sequence) throw new TypeError('交接序号必须严格递增');
    sequence = handoff.sequence;
    if (![handoff.from, handoff.to].every(id => id === 'human' || actorIds.has(String(id)))) throw new TypeError('交接角色引用无效');
    if (!['inform', 'completed', 'input-required'].includes(String(handoff.kind))) throw new TypeError('交接类型无效');
  }
}
