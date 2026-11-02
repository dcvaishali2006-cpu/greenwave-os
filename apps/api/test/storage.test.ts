import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../src/app.js';
import { openStorage, SqliteStorage } from '../src/storage.js';

const dir = mkdtempSync(join(tmpdir(), 'gw-db-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'test.db');
const opts = { port: 0, tickMs: 3_600_000, loginLimitPerMin: 1000 };

async function boot() {
  const storage = await SqliteStorage.open(file);
  const loaded = await storage.load();
  const ctx = createApp({ ...opts, storage, loaded });
  const port = await ctx.start();
  const base = `http://localhost:${port}/api/v1`;
  const call = async (path: string, init: RequestInit & { token?: string } = {}) => {
    const r = await fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) } });
    return { status: r.status, body: (await r.json()) as any };
  };
  const login = async (email: string, password = 'demo1234') => (await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).body.accessToken as string;
  return { ctx, call, login };
}

test('first start saves the demo users; audit entries and a new user survive a restart', async () => {
  const a = await boot();
  assert.equal((await a.call('/health')).body.storage, 'sqlite');
  const admin = await a.login('admin@demo.com');
  const op = await a.login('operator@demo.com');
  await a.call('/live/controller', { method: 'POST', token: op, body: JSON.stringify({ controller: 'fixed' }) });
  const made = await a.call('/admin/users', { method: 'POST', token: admin, body: JSON.stringify({ email: 'new@demo.com', name: 'New Person', role: 'viewer', password: 'longenough1' }) });
  assert.equal(made.status, 201);
  const before = (await a.call('/admin/audit?limit=500', { token: admin })).body.length;
  await a.ctx.close();

  const b = await boot();
  const admin2 = await b.login('admin@demo.com'); // the same password still works
  assert.ok(await b.login('new@demo.com', 'longenough1'), 'created user can sign in after restart');
  const audit = (await b.call('/admin/audit?limit=500', { token: admin2 })).body as { action: string; id: number }[];
  assert.ok(audit.length >= before, 'old entries are still there');
  assert.ok(audit.some((e) => e.action === 'switch_controller'));
  assert.ok(audit.some((e) => e.action === 'create_user'));
  const ids = audit.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'ids stay unique after restart');
  assert.equal((await b.call('/admin/users', { token: admin2 })).body.length, 4, 'demo users were not duplicated');
  await b.ctx.close();
});

test('creating users: admin only, duplicate email rejected, short password rejected', async () => {
  const a = await boot();
  const op = await a.login('operator@demo.com');
  const admin = await a.login('admin@demo.com');
  const body = (o: object) => JSON.stringify({ email: 'x@demo.com', name: 'X', role: 'viewer', password: 'longenough1', ...o });
  assert.equal((await a.call('/admin/users', { method: 'POST', token: op, body: body({}) })).status, 403);
  assert.equal((await a.call('/admin/users', { method: 'POST', token: admin, body: body({ email: 'ADMIN@demo.com' }) })).status, 409);
  assert.equal((await a.call('/admin/users', { method: 'POST', token: admin, body: body({ password: 'short' }) })).status, 400);
  const log = (await a.call('/admin/audit?action=forbidden', { token: admin })).body;
  assert.ok(log.length >= 1, 'denied attempt is audited');
  await a.ctx.close();
});

test('storage choice: DB=memory keeps nothing; default is a file', async () => {
  assert.equal((await openStorage({ DB: 'memory' } as NodeJS.ProcessEnv)).kind, 'memory');
  const s = await openStorage({ DB_PATH: join(dir, 'x.db') } as NodeJS.ProcessEnv);
  assert.equal(s.kind, 'sqlite');
  await s.close();
});
