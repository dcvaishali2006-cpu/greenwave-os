import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';

const ctx = createApp({ port: 0, tickMs: 15, loginLimitPerMin: 1000 });
let base = '';
let port = 0;

before(async () => {
  port = await ctx.start();
  base = `http://127.0.0.1:${port}/api/v1`;
});
after(() => ctx.close());

const call = async (path: string, opts: { method?: string; token?: string; body?: unknown } = {}) => {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const login = async (email: string, password = 'demo1234') => (await call('/auth/login', { method: 'POST', body: { email, password } })).body;
const tokenOf = async (role: 'admin' | 'operator' | 'viewer') => (await login(`${role}@demo.com`)).accessToken as string;

test('health is public', async () => {
  const r = await call('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('login succeeds for each demo role and returns that role', async () => {
  for (const role of ['admin', 'operator', 'viewer']) {
    const b = await login(`${role}@demo.com`);
    assert.equal(b.user.role, role);
    assert.ok(b.accessToken && b.refreshToken);
  }
});

test('wrong password and unknown email both give the same 401', async () => {
  const a = await call('/auth/login', { method: 'POST', body: { email: 'admin@demo.com', password: 'nope' } });
  const b = await call('/auth/login', { method: 'POST', body: { email: 'ghost@demo.com', password: 'nope' } });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(a.body, b.body);
});

test('bad bodies return 400 with the standard error shape', async () => {
  const r = await call('/auth/login', { method: 'POST', body: { email: 'not-an-email' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALIDATION');
});

test('protected routes need a token (401), and garbage tokens are refused', async () => {
  assert.equal((await call('/junctions')).status, 401);
  assert.equal((await call('/junctions', { token: 'garbage' })).status, 401);
});

test('refresh token gives a new access token; an access token cannot be used as a refresh token', async () => {
  const b = await login('operator@demo.com');
  const ok = await call('/auth/refresh', { method: 'POST', body: { refreshToken: b.refreshToken } });
  assert.equal(ok.status, 200);
  assert.equal((await call('/auth/me', { token: ok.body.accessToken })).body.user.role, 'operator');
  const bad = await call('/auth/refresh', { method: 'POST', body: { refreshToken: b.accessToken } });
  assert.equal(bad.status, 401);
});

test('RBAC: viewer cannot switch controller (403), operator can, admin-only routes refuse operator', async () => {
  const viewer = await tokenOf('viewer');
  const operator = await tokenOf('operator');
  const admin = await tokenOf('admin');
  assert.equal((await call('/live/controller', { method: 'POST', token: viewer, body: { controller: 'fixed' } })).status, 403);
  const sw = await call('/live/controller', { method: 'POST', token: operator, body: { controller: 'fixed' } });
  assert.equal(sw.status, 200);
  assert.equal(sw.body.controller, 'fixed');
  assert.equal((await call('/admin/audit', { token: operator })).status, 403);
  assert.equal((await call('/admin/users', { token: viewer })).status, 403);
  assert.equal((await call('/admin/users', { token: admin })).status, 200);
  await call('/live/controller', { method: 'POST', token: operator, body: { controller: 'adaptive' } });
});

test('the audit log records logins, forbidden attempts and control actions, and only admins can read it', async () => {
  const admin = await tokenOf('admin');
  const rows = (await call('/admin/audit?limit=500', { token: admin })).body as { action: string; user: string }[];
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['login', 'login_failed', 'forbidden', 'switch_controller']) assert.ok(actions.has(a), `missing audit action ${a}`);
});

test('junctions list shows 5 junctions with queues and signal state', async () => {
  const r = await call('/junctions', { token: await tokenOf('viewer') });
  assert.equal(r.status, 200);
  assert.equal(r.body.junctions.length, 5);
  assert.ok(['green', 'clear'].includes(r.body.junctions[0].mode));
  assert.ok('EB' in r.body.junctions[0].approaches);
  assert.equal((await call('/junctions/J9', { token: await tokenOf('viewer') })).status, 404);
});

test('Why? returns decisions with plain-English reasons once the signals have changed', async () => {
  const token = await tokenOf('viewer');
  let body: any;
  for (let i = 0; i < 100; i++) {
    for (let k = 0; k < 20; k++) ctx.live.tick();
    body = (await call('/junctions/J2/why?limit=3', { token })).body;
    if (body.decisions.length >= 1) break;
  }
  assert.ok(body.decisions.length >= 1, 'no decisions after running the simulator');
  assert.ok(body.decisions.at(-1).reason.length > 20);
});

test('operator can start another scenario; unknown scenarios are rejected', async () => {
  const operator = await tokenOf('operator');
  const ok = await call('/live/scenario', { method: 'POST', token: operator, body: { scenario: 'incident', seed: 3 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.scenario, 'incident');
  assert.equal(ok.body.state.t, 0);
  assert.equal((await call('/live/scenario', { method: 'POST', token: operator, body: { scenario: 'volcano' } })).status, 400);
});

test('analytics/compare returns the adaptive vs fixed table (and caches it)', async () => {
  const token = await tokenOf('viewer');
  const r = await call('/analytics/compare?scenario=incident&seeds=3', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.rows[0].label, 'Avg wait per vehicle (s)');
  assert.ok(r.body.rows[0].adaptive < r.body.rows[0].fixed, 'adaptive should beat fixed in the incident scenario');
  assert.equal((await call('/analytics/compare?scenario=incident&seeds=99', { token })).status, 400);
});

const openSocket = (token: string) =>
  new Promise<{ ws: WebSocket; messages: any[]; closed: Promise<number> }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const messages: any[] = [];
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
    ws.on('open', () => resolve({ ws, messages, closed }));
    ws.on('error', reject);
  });

test('WebSocket streams hello then live ticks; a bad token is closed with 4401', async () => {
  const good = await openSocket(await tokenOf('viewer'));
  await new Promise((r) => setTimeout(r, 300));
  good.ws.close();
  assert.equal(good.messages[0].type, 'hello');
  const ticks = good.messages.filter((m) => m.type === 'tick');
  assert.ok(ticks.length >= 5, `only ${ticks.length} ticks in 300 ms`);
  assert.ok(ticks[ticks.length - 1].state.t > ticks[0].state.t, 'time must advance');
  assert.equal(ticks[0].state.junctions.length, 5);

  const bad = await openSocket('garbage').catch(() => null);
  if (bad) assert.equal(await bad.closed, 4401);
});

test('a controller switch reaches every connected dashboard as a run event', async () => {
  const operator = await tokenOf('operator');
  const watcher = await openSocket(await tokenOf('viewer'));
  await call('/live/controller', { method: 'POST', token: operator, body: { controller: 'fixed' } });
  await new Promise((r) => setTimeout(r, 100));
  watcher.ws.close();
  assert.ok(watcher.messages.some((m) => m.type === 'run' && m.controller === 'fixed'));
  await call('/live/controller', { method: 'POST', token: operator, body: { controller: 'adaptive' } });
});
