/** 本地演示宿主：模拟规划与执行，不连接任何真实模型服务。 */
import express from 'express';
import { resolve } from 'node:path';
import { createRuntime } from '../src/runtime.js';
import { SqliteStore } from '../src/sqlite.js';
import { createRuntimeRouter } from '../src/http.js';
import { DemoPlanner, FakeExecutor } from '../src/testing.js';

const dataDirectory = resolve(process.env.GOALSPLIT_DATA_DIR ?? 'data');
const store = new SqliteStore(resolve(dataDirectory, 'goalsplit.sqlite'));
const runtime = await createRuntime({ store, planner: new DemoPlanner(), executors: { fake: new FakeExecutor(Number(process.env.GOALSPLIT_STEP_MS ?? 450)) } });
const app = express(); app.use('/api', createRuntimeRouter(runtime));
let vite: import('vite').ViteDevServer | undefined;
if (process.argv.includes('--dev')) {
  const { createServer } = await import('vite'); vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' }); app.use(vite.middlewares);
} else {
  app.use(express.static(resolve('dist/panel'))); app.get('/{*path}', (_req, res) => { res.sendFile(resolve('dist/panel/index.html')); });
}
const port = Number(process.env.PORT ?? 4317);
const server = app.listen(port, '127.0.0.1', () => { console.log(`GoalSplit 已启动：http://127.0.0.1:${port}`); });
let closing = false;
/** 排空当前执行并保存暂停状态，然后关闭服务与数据库。 */
async function shutdown(): Promise<void> {
  if (closing) return; closing = true;
  await runtime.close(); await vite?.close(); server.closeAllConnections(); server.close(); store.close();
}
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
