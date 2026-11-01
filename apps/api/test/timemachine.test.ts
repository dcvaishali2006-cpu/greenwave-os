import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';

const ctx = createApp({ port: 0, tickMs: 1000, loginLimitPerMin: 1000 });
let base = '';
before(async () => {
  base = `http://127.0.0.1:${await ctx.start()}/api/v1`;
});
after(() => ctx.close());

const call = async (path: string, token?: string) => {
  const res = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: (await res.json()) as any };
};
const viewer = async () => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'viewer@demo.com', password: 'demo1234' }) });
  return ((await r.json()) as any).accessToken as string;
};

test('time machine needs a signed-in user', async () => {
  assert.equal((await call('/timemachine/fork')).status, 401);
});

test('a read-only viewer can run a fork: three branches from one shared past, plus a multi-seed check', async () => {
  const t = await viewer();
  const r = await call('/timemachine/fork?scenario=incident&at=1200&window=900&history=fixed&seeds=2', t);
  assert.equal(r.status, 200);
  assert.equal(r.body.branches.length, 3);
  assert.equal(r.body.history, 'fixed');
  assert.equal(r.body.branches.filter((b: any) => b.unchanged).length, 1);
  assert.deepEqual(new Set(r.body.branches.map((b: any) => JSON.stringify(b.atFork))).size, 1);
  assert.equal(r.body.robustness.seeds.length, 2);
  assert.ok(r.body.branches[0].series.length > 10);
});

test('the same request is served again identically (cached)', async () => {
  const t = await viewer();
  const q = '/timemachine/fork?scenario=normal&at=600&window=300&seeds=1';
  const a = await call(q, t);
  const b = await call(q, t);
  assert.deepEqual(a.body, b.body);
});

test('bad parameters give 400 with the standard error shape; the live sim is not touched', async () => {
  const t = await viewer();
  const before = ctx.live.time;
  for (const q of ['scenario=volcano', 'at=-1', 'at=99999', 'window=5', 'history=magic', 'seeds=99', 'at=abc']) {
    const r = await call(`/timemachine/fork?${q}`, t);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.error.code, 'VALIDATION', q);
  }
  const late = await call('/timemachine/fork?at=3540&window=3600', t);
  assert.equal(late.status, 200, 'a fork near the end is cut to the hour, not an error');
  assert.equal(ctx.live.time, before, 'time machine never advances the live simulation');
});
