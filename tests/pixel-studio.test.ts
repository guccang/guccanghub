import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@cordisjs/core';
import { dagPlugin } from '../cordis/dag.js';
import { agentRunToStudio, dagStudioBridgePlugin, pixelStudioPlugin, validateStudioSnapshot, type StudioSnapshot } from '../pixel-studio/index.js';
import type { AgentRunSnapshot } from '../agents-dag-context/types.js';
const snapshot = (revision = 1): StudioSnapshot => ({
  version: 1, runId: 'run', title: '显示接口测试', revision,
  actors: [{ id: 'agent', name: '研究员', character: 'jim', status: 'working', activity: '研究' }],
  tasks: [{ id: 'task', title: '研究', actorId: 'agent', status: 'working' }],
  handoffs: [{ sequence: 5, from: 'human', to: 'agent', kind: 'inform' }],
});

test('像素服务隔离外部数据、拒绝旧快照并标记重连基线', async () => {
  const ctx = new Context();
  const fork = ctx.plugin(pixelStudioPlugin);
  await ctx.start();
  try {
    const service = ctx.pixelStudio;
    let updates = 0;
    service.subscribe(() => { updates++; });
    const input = snapshot();
    assert.equal(service.publish(input), true);
    assert.notEqual(service.getSnapshot().snapshot, input);
    assert.ok(Object.isFrozen(service.getSnapshot().snapshot!.actors[0]));
    const epoch = service.getSnapshot().connectionEpoch;
    service.selectActor('agent');
    assert.throws(() => service.selectActor('missing'));
    assert.equal(service.publish(snapshot(0)), false);
    service.setConnected(false);
    assert.equal(service.getSnapshot().connected, false);
    service.publish(snapshot(), { reconnect: true });
    assert.equal(service.getSnapshot().connected, true);
    assert.equal(service.getSnapshot().connectionEpoch, epoch + 1);
    service.publish(snapshot(2));
    assert.equal(service.getSnapshot().connectionEpoch, epoch + 1);
    assert.equal(service.getSnapshot().snapshot!.handoffs[0].sequence, 5);
    assert.equal(service.getSnapshot().selectedActorId, 'agent');
    service.publish({ ...snapshot(3), runId: 'different' });
    assert.equal(service.getSnapshot().selectedActorId, null);
    const count = updates;
    await fork.dispose();
    service.setConnected(false);
    assert.equal(updates, count);
    assert.equal(ctx.pixelStudio, undefined);
  } finally { await ctx.stop(); }
});

test('显示协议拒绝重复身份、未知引用和乱序事件', () => {
  validateStudioSnapshot(snapshot());
  assert.throws(() => validateStudioSnapshot({ ...snapshot(), version: 2 }));
  assert.throws(() => validateStudioSnapshot({ ...snapshot(), actors: [{ ...snapshot().actors[0], id: 'human' }] }));
  assert.throws(() => validateStudioSnapshot({ ...snapshot(), actors: [...snapshot().actors, ...snapshot().actors] }));
  assert.throws(() => validateStudioSnapshot({ ...snapshot(), tasks: [{ ...snapshot().tasks[0], actorId: 'missing' }] }));
  assert.throws(() => validateStudioSnapshot({ ...snapshot(), handoffs: [...snapshot().handoffs, ...snapshot().handoffs] }));
});

test('context 适配按真实 agentId 合并人物，UNKNOWN 保持结果待确认', () => {
  const run: AgentRunSnapshot = {
    schemaVersion: 1, runId: 'run', createdAt: '', goal: { objective: '目标', context: {} },
    graph: {
      nodes: ['one', 'two'].map(id => ({ id, data: { agentId: 'agent', instruction: id, contextRef: { relativeDir: id } } })), edges: [],
    },
    states: {
      one: { nodeId: 'one', status: 'SUCCEEDED', attempt: 1, updatedAt: '', history: [] },
      two: { nodeId: 'two', status: 'UNKNOWN', attempt: 1, updatedAt: '', history: [] },
    },
  };
  const display = agentRunToStudio(run, { revision: 1 });
  validateStudioSnapshot(display);
  assert.equal(display.actors.length, 1);
  assert.equal(display.actors[0].status, 'unknown');
  assert.equal(display.tasks.length, 2);
});

test('DAG 投影随图更新，卸载后停止更新显示服务', async () => {
  const ctx = new Context();
  ctx.plugin(dagPlugin);
  ctx.plugin(pixelStudioPlugin);
  const bridge = ctx.plugin(dagStudioBridgePlugin);
  await ctx.start();
  try {
    ctx.dagGraph.apply([{ type: 'addNode', node: { id: 'research', data: { agentId: 'researcher', label: '研究', status: 'RUNNING' } } }]);
    assert.equal(ctx.pixelStudio.getSnapshot().snapshot!.actors[0].status, 'working');
    const revision = ctx.pixelStudio.getSnapshot().snapshot!.revision;
    await bridge.dispose();
    ctx.dagGraph.apply([{ type: 'removeNode', id: 'research' }]);
    assert.equal(ctx.pixelStudio.getSnapshot().snapshot!.revision, revision);
  } finally { await ctx.stop(); }
});
