import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { z, ZodError } from 'zod';
import { runBenchmark, SCENARIOS } from '@greenwave/engine';
import { AuditLog } from './audit.js';
import { ApiError, AuthService, requireAuth, requireRole } from './auth.js';
import { config } from './config.js';
import { CONTROLLER_NAMES, LiveSim, type ControllerName } from './liveSim.js';
import { attachWebSocket } from './ws.js';

export interface AppOptions {
  /** 0 picks a free port (tests). */
  port?: number;
  /** Real milliseconds per simulated second. Default: 1000 / SIM_SPEED. */
  tickMs?: number;
  /** Max login attempts per minute per client (tests raise this). */
  loginLimitPerMin?: number;
  scenario?: string;
  seed?: number;
  controller?: ControllerName;
}

const scenarioNames = Object.keys(SCENARIOS) as [string, ...string[]];
const loginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const refreshBody = z.object({ refreshToken: z.string().min(10) });
const controllerBody = z.object({ controller: z.enum(CONTROLLER_NAMES as [string, ...string[]]) });
const scenarioBody = z.object({
  scenario: z.enum(scenarioNames).optional(),
  seed: z.number().int().min(0).max(1_000_000).optional(),
  controller: z.enum(CONTROLLER_NAMES as [string, ...string[]]).optional(),
});
const whyQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(5) });
const compareQuery = z.object({ scenario: z.enum(scenarioNames).default('incident'), seeds: z.coerce.number().int().min(1).max(10).default(5) });
const auditQuery = z.object({ action: z.string().optional(), email: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });

export function createApp(opts: AppOptions = {}) {
  const live = new LiveSim({
    scenario: opts.scenario ?? config.simScenario,
    seed: opts.seed ?? config.simSeed,
    controller: opts.controller ?? 'adaptive',
    speed: config.simSpeed,
    tickMs: opts.tickMs,
  });
  const auth = new AuthService();
  const audit = new AuditLog();
  const app = express();
  const api = express.Router();
  const authed = requireAuth(auth);
  const compareCache = new Map<string, ReturnType<typeof runBenchmark>>();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.webOrigin }));
  app.use(express.json({ limit: '50kb' }));

  api.get('/health', (_req, res) => res.json({ ok: true, time: live.time }));

  // ---- Authentication ----
  const loginLimiter = rateLimit({ windowMs: 60_000, limit: opts.loginLimitPerMin ?? 10, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Wait a minute.' } } });

  api.post('/auth/login', loginLimiter, (req, res) => {
    const body = loginBody.parse(req.body);
    try {
      const { user, accessToken, refreshToken } = auth.login(body.email, body.password);
      audit.add(user, 'login');
      res.json({ accessToken, refreshToken, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    } catch (e) {
      audit.add(null, 'login_failed', { email: body.email });
      throw e;
    }
  });

  api.post('/auth/refresh', (req, res) => {
    res.json(auth.refresh(refreshBody.parse(req.body).refreshToken));
  });

  api.get('/auth/me', authed, (req, res) => {
    const u = auth.users.find((x) => x.id === req.user!.id)!;
    res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role } });
  });

  // ---- Live network (any signed-in role) ----
  api.get('/junctions', authed, (_req, res) => res.json(live.state()));

  api.get('/junctions/:id', authed, (req, res) => {
    const j = live.state().junctions.find((x) => x.id.toLowerCase() === String(req.params.id).toLowerCase());
    if (!j) throw new ApiError(404, 'NOT_FOUND', `No junction ${req.params.id}.`);
    res.json({ ...j, lastDecision: live.decisions(j.id, 1)[0] ?? null });
  });

  /** The Why? button: plain-English reasons for the latest signal changes at one junction. */
  api.get('/junctions/:id/why', authed, (req, res) => {
    const id = String(req.params.id).toUpperCase();
    if (!live.state().junctions.some((j) => j.id === id)) throw new ApiError(404, 'NOT_FOUND', `No junction ${req.params.id}.`);
    res.json({ junctionId: id, decisions: live.decisions(id, whyQuery.parse(req.query).limit) });
  });

  api.get('/live/status', authed, (_req, res) => res.json({ ...live.status(), metrics: live.metrics() }));
  api.get('/live/plan-changes', authed, (_req, res) => res.json(live.planChanges()));

  // ---- Control (operator, admin) ----
  const canControl = requireRole(audit, 'operator', 'admin');

  api.post('/live/controller', authed, canControl, (req, res) => {
    const { controller } = controllerBody.parse(req.body);
    const from = live.cfg.controller;
    live.setController(controller as ControllerName);
    audit.add(req.user!, 'switch_controller', { from, to: controller, atSecond: live.time });
    res.json(live.status());
  });

  api.post('/live/scenario', authed, canControl, (req, res) => {
    const body = scenarioBody.parse(req.body ?? {});
    live.reset(body as Parameters<LiveSim['reset']>[0]);
    audit.add(req.user!, 'start_scenario', body);
    res.json({ ...live.status(), state: live.state() });
  });

  // ---- Analytics (any signed-in role) ----
  api.get('/analytics/compare', authed, (req, res) => {
    const q = compareQuery.parse(req.query);
    const key = `${q.scenario}:${q.seeds}`;
    let result = compareCache.get(key);
    if (!result) {
      result = runBenchmark(q.scenario, Array.from({ length: q.seeds }, (_, i) => i + 1));
      compareCache.set(key, result);
    }
    res.json(result);
  });

  // ---- Admin ----
  const adminOnly = requireRole(audit, 'admin');
  api.get('/admin/audit', authed, adminOnly, (req, res) => res.json(audit.list(auditQuery.parse(req.query))));
  api.get('/admin/users', authed, adminOnly, (_req, res) => res.json(auth.users.map(({ passwordHash: _h, ...u }) => u)));

  app.use('/api/v1', api);

  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'No such route.')));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return res.status(400).json({ error: { code: 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') } });
    if (err instanceof SyntaxError) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid JSON.' } });
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });

  const server = createServer(app);
  const wss = attachWebSocket(server, live, auth);

  return {
    app,
    live,
    auth,
    audit,
    server,
    /** Start listening and start the simulation clock. Resolves with the port. */
    start: () =>
      new Promise<number>((resolve) => {
        server.listen(opts.port ?? config.port, () => {
          live.start();
          resolve((server.address() as { port: number }).port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        live.stop();
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
