/** 可挂载的 HTTP/SSE 路由；所有控制操作均调用同一个 SDK 实例。 */
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import type { Runtime } from './runtime.js';
import { proposalSchema, resultSchema } from './types.js';

/** 创建 /api 路由，宿主负责绑定地址和应用级身份验证。 */
export function createRuntimeRouter(runtime: Runtime): express.Router {
  const router = express.Router(); router.use(express.json({ limit: '1mb' }));
  router.get('/runs', (_req, res) => { res.json(runtime.listRuns().map(run => ({ id: run.id, goal: run.goal, status: run.status, planVersion: run.planVersion, createdAt: run.createdAt }))); });
  router.post('/runs', (req, res) => {
    const body = z.object({ goal: z.unknown(), initialPlan: z.unknown().optional(), commandId: z.string().min(1) }).strict().parse(req.body);
    res.status(201).json({ id: runtime.createRun(body, body.commandId) });
  });
  router.get('/runs/:id', (req, res) => { res.json({ snapshot: runtime.getSnapshot(req.params.id, req.query.atSeq === undefined ? undefined : z.coerce.number().int().positive().parse(req.query.atSeq)), controls: runtime.controls(req.params.id) }); });
  router.get('/runs/:id/history', (req, res) => {
    const after = z.coerce.number().int().nonnegative().parse(req.query.after ?? 0);
    res.json(runtime.listEvents(req.params.id, after));
  });
  router.post('/runs/:id/commands', (req, res) => {
    const body = z.object({ action: z.enum(['start', 'pause', 'resume', 'interrupt', 'rerun', 'restart', 'resolve', 'input']), commandId: z.string().min(1), taskId: z.string().optional(), attemptId: z.string().optional(), result: resultSchema.optional(), text: z.string().optional() }).strict().parse(req.body);
    const id = req.params.id;
    if (body.action === 'rerun') runtime.rerunTask(id, z.string().min(1).parse(body.taskId), body.commandId);
    else if (body.action === 'restart') { res.json({ id: runtime.restartRun(id, body.commandId) }); return; }
    else if (body.action === 'resolve') runtime.resolveAttempt(id, z.string().parse(body.attemptId), resultSchema.parse(body.result), body.commandId);
    else if (body.action === 'input') runtime.addInput(id, z.string().min(1).parse(body.text), body.commandId);
    else runtime[body.action](id, body.commandId);
    res.json({ snapshot: runtime.getSnapshot(id), controls: runtime.controls(id) });
  });
  router.post('/runs/:id/plans', (req, res) => {
    const body = z.object({ proposal: proposalSchema, commandId: z.string().min(1) }).strict().parse(req.body);
    runtime.proposePlan(req.params.id, body.proposal, body.commandId); res.json({ snapshot: runtime.getSnapshot(req.params.id) });
  });
  router.put('/runs/:id/layout', (req, res) => {
    const layout = z.record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite() })).parse(req.body);
    runtime.saveLayout(req.params.id, layout); res.status(204).end();
  });
  router.get('/runs/:id/artifacts/:artifactId', (req, res) => {
    const artifact = runtime.getSnapshot(req.params.id).artifacts.find(item => item.id === req.params.artifactId);
    if (!artifact) { res.status(404).json({ error: '产物不存在' }); return; }
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`);
    res.type(artifact.mediaType).send(Buffer.from(runtime.readArtifact(req.params.id, artifact.id)));
  });
  router.get('/runs/:id/events', (req, res) => {
    const id = req.params.id; runtime.getSnapshot(id);
    let cursor = z.coerce.number().int().nonnegative().parse(req.get('Last-Event-ID') ?? req.query.after ?? 0);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    let waitingDrain = false;
    /** 从数据库补读，通知丢失时轮询仍可补齐；遵守响应背压。 */
    const flush = () => {
      if (res.destroyed || waitingDrain) return;
      try {
        for (const event of runtime.listEvents(id, cursor, 256)) {
          const writable = res.write(`id: ${event.seq}\nevent: runtime\ndata: ${JSON.stringify(event)}\n\n`); cursor = event.seq;
          if (!writable) { waitingDrain = true; break; }
        }
      } catch { res.end(); }
    };
    const unsubscribe = runtime.subscribe(event => { if (event.runId === id) flush(); });
    const polling = setInterval(flush, 250); const keepalive = setInterval(() => { if (!waitingDrain) res.write(': heartbeat\n\n'); }, 15000);
    res.on('drain', () => { waitingDrain = false; flush(); });
    res.on('close', () => { clearInterval(polling); clearInterval(keepalive); unsubscribe(); }); flush();
  });
  /** 将协议错误变为可展示的 JSON，不向前端泄露内部堆栈。 */
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (!res.headersSent) res.status(error instanceof z.ZodError ? 400 : 409).json({ error: error instanceof Error ? error.message : String(error) });
  };
  router.use(errors); return router;
}
