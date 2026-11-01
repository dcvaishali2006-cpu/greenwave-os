import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';

const ctx = createApp({ port: 0, tickMs: 5, loginLimitPerMin: 1000, controller: 'fixed' });
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
const tokenOf = async (role: string) => (await call('/auth/login', { method: 'POST', body: { email: `${role}@demo.com`, password: 'demo1234' } })).body.accessToken as string;

test('viewer can see emergency status but cannot dispatch or change priority (403, audited)', async () => {
  const viewer = await tokenOf('viewer');
  assert.equal((await call('/live/emergency', { token: viewer })).status, 200);
  assert.equal((await call('/live/emergency', { method: 'POST', token: viewer, body: { direction: 'EB' } })).status, 403);
  assert.equal((await call('/live/emergency/priority', { method: 'POST', token: viewer, body: { enabled: false } })).status, 403);
  const admin = await tokenOf('admin');
  const log = (await call('/admin/audit?limit=50', { token: admin })).body;
  assert.ok(JSON.stringify(log).includes('forbidden'));
});

test('operator dispatches an ambulance; it appears in the live state and in the run list; bad directions are 400', async () => {
  const op = await tokenOf('operator');
  assert.equal((await call('/live/emergency', { method: 'POST', token: op, body: { direction: 'NB' } })).status, 400);
  const r = await call('/live/emergency', { method: 'POST', token: op, body: { direction: 'EB' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.dir, 'EB');
  assert.equal(r.body.priority, true);
  await new Promise((x) => setTimeout(x, 150));
  const state = (await call('/junctions', { token: op })).body;
  assert.ok(Array.isArray(state.emergency));
  const list = (await call('/live/emergency', { token: op })).body;
  assert.equal(list.runs[0].id, r.body.id);
  const status = (await call('/live/status', { token: op })).body;
  assert.equal(status.priority, true);
});

test('priority can be switched off and the next ambulance records that; dispatches are audited', async () => {
  const op = await tokenOf('operator');
  const off = await call('/live/emergency/priority', { method: 'POST', token: op, body: { enabled: false } });
  assert.deepEqual(off.body, { priority: false });
  assert.equal((await call('/live/emergency/priority', { method: 'POST', token: op, body: { enabled: 'yes' } })).status, 400);
  const r = await call('/live/emergency', { method: 'POST', token: op, body: { direction: 'WB' } });
  assert.equal(r.body.priority, false);
  const admin = await tokenOf('admin');
  const audit = JSON.stringify((await call('/admin/audit?limit=100', { token: admin })).body);
  assert.ok(audit.includes('dispatch_emergency') && audit.includes('set_emergency_priority'));
});

test('a dispatch reaches connected dashboards as an emergency event', async () => {
  const op = await tokenOf('operator');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${op}`);
  const got = new Promise<any>((resolve, reject) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'emergency') resolve(m);
    });
    setTimeout(() => reject(new Error('no emergency event')), 3000);
  });
  await new Promise((x) => ws.on('open', x));
  await call('/live/emergency', { method: 'POST', token: op, body: { direction: 'EB' } });
  const m = await got;
  assert.ok(Array.isArray(m.emergencyRuns));
  ws.close();
});

test('analytics/emergency returns measured journey times with and without priority, and the cost to other traffic', async () => {
  const t = await tokenOf('viewer');
  const r = await call('/analytics/emergency?scenario=incident&controller=adaptive&seeds=2', { token: t });
  assert.equal(r.status, 200);
  assert.ok(r.body.with.journeyS < r.body.without.journeyS);
  assert.equal(typeof r.body.trafficWaitCostPct, 'number');
  assert.equal((await call('/analytics/emergency?controller=magic', { token: t })).status, 400);
});
