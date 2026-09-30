/** 纯图算法与结构校验，不依赖数据库或执行器。 */
import { graphSchema, type Graph, type PlanProposal, type TaskSpec } from './types.js';

/** 返回稳定的 JSON 表示，使指纹不受对象属性顺序影响。 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** 校验依赖、输出引用和执行器，并以拓扑顺序返回规范图。 */
export function validateGraph(input: unknown, executors: Set<string>): Graph {
  const graph = graphSchema.parse(input);
  const byId = new Map(graph.tasks.map(task => [task.id, task]));
  if (byId.size !== graph.tasks.length) throw new Error('节点 ID 重复');
  for (const task of graph.tasks) {
    if (!executors.has(task.executor)) throw new Error(`执行器不可用：${task.executor}`);
    if (new Set(task.dependencies).size !== task.dependencies.length) throw new Error(`依赖重复：${task.id}`);
    if (new Set(task.outputs).size !== task.outputs.length) throw new Error(`输出名重复：${task.id}`);
    for (const dependency of task.dependencies) if (!byId.has(dependency)) throw new Error(`依赖不存在：${dependency}`);
    for (const ref of task.contextRefs) {
      if (!task.dependencies.includes(ref.taskId) || !byId.get(ref.taskId)?.outputs.includes(ref.output)) throw new Error(`上下文引用无效：${ref.taskId}.${ref.output}`);
    }
    task.dependencies.sort(); task.resources = [...new Set(task.resources)].sort();
  }
  const pending = new Map(graph.tasks.map(task => [task.id, task]));
  const sorted: TaskSpec[] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter(task => task.dependencies.every(id => !pending.has(id))).sort((a, b) => a.id.localeCompare(b.id));
    if (!ready.length) throw new Error('任务图包含环');
    for (const task of ready) { sorted.push(task); pending.delete(task.id); }
  }
  return { tasks: sorted };
}

/** 应用候选操作；提交前仍需对完整结果进行校验。 */
export function applyOperations(graph: Graph | undefined, proposal: PlanProposal): Graph {
  const tasks = new Map((graph?.tasks ?? []).map(task => [task.id, structuredClone(task)]));
  for (const op of proposal.operations) {
    if (op.type === 'addTask') {
      if (tasks.has(op.task.id)) throw new Error(`节点已经存在：${op.task.id}`);
      tasks.set(op.task.id, structuredClone(op.task)); continue;
    }
    const task = tasks.get(op.taskId);
    if (!task) throw new Error(`节点不存在：${op.taskId}`);
    if (op.type === 'removeTask') tasks.delete(op.taskId);
    else if (op.type === 'updateTask') Object.assign(task, op.changes);
    else if (op.type === 'addDependency') task.dependencies.push(op.dependencyId);
    else task.dependencies = task.dependencies.filter(id => id !== op.dependencyId);
  }
  return { tasks: [...tasks.values()] };
}

/** 求节点及其全部后继；用于结果失效传播。 */
export function descendants(graph: Graph | undefined, seeds: Iterable<string>): Set<string> {
  const affected = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of graph?.tasks ?? []) if (!affected.has(task.id) && task.dependencies.some(id => affected.has(id))) { affected.add(task.id); changed = true; }
  }
  return affected;
}
