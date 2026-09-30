/** HTTP 与 SSE 集成测试：验证挂载、幂等命令、历史和断线补读。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createRuntime } from '../src/runtime.js';
import { createRuntimeRouter } from '../src/http.js';
import { SqliteStore } from '../src/sqlite.js';
import { FakeExecutor, FakePlanner, makeTask } from '../src/testing.js';

test('HTTP 控制、SSE Last-Event-ID 续传和历史快照', async t => {
  const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), 'goalsplit-http-')), 'db.sqlite'));
  const runtime = await createRuntime({ store, planner: new FakePlanner(), executors: { fake: new FakeExecutor(1) } });
  const app = express(); app.use('/api', createRuntimeRouter(runtime)); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => { server.closeAllConnections(); server.close(); await runtime.close({ abandon: true }); store.close(); });
  /** 向本地路由发送 JSON 请求。 */
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const creation = { goal: { objective: 'HTTP 测试' }, initialPlan: { tasks: [makeTask('task')] }, commandId: 'http-create' };
  const { id } = await (await post('/runs', creation)).json() as { id: string };
  const duplicate = await (await post('/runs', creation)).json() as { id: string }; assert.equal(duplicate.id, id);
  await post(`/runs/${id}/commands`, { action: 'start', commandId: 'http-start' });
  for (let i = 0; i < 200 && runtime.getSnapshot(id).status !== 'SUCCEEDED'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runtime.getSnapshot(id).status, 'SUCCEEDED');
  const old = await (await fetch(`${base}/runs/${id}?atSeq=1`)).json() as { snapshot: { status: string; attempts: unknown[] } };
  assert.equal(old.snapshot.status, 'CREATED'); assert.equal(old.snapshot.attempts.length, 0);
  const controller = new AbortController();
  const response = await fetch(`${base}/runs/${id}/events?after=0`, { signal: controller.signal, headers: { 'Last-Event-ID': '2' } });
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const reader = response.body!.getReader(); const chunk = new TextDecoder().decode((await reader.read()).value); controller.abort();
  assert.match(chunk, /id: 3\nevent: runtime/); assert.doesNotMatch(chunk, /id: 1\nevent/);
  const invalid = await post(`/runs/${id}/commands`, { action: 'unknown', commandId: 'bad' }); assert.equal(invalid.status, 400);
  const artifact = runtime.getSnapshot(id).artifacts[0];
  const download = await fetch(`${base}/runs/${id}/artifacts/${artifact.id}`); assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition')!, /attachment/);
});
