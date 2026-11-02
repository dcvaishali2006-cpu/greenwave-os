import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { PostgresStorage } from '../src/storage.js';

// Runs only when TEST_DATABASE_URL points at an empty PostgreSQL database.
const url = process.env.TEST_DATABASE_URL;

async function boot() {
  const storage = await PostgresStorage.open(url!);
  const loaded = await storage.load();
  const ctx = createApp({ port: 0, tickMs: 3_600_000, loginLimitPerMin: 1000, storage, loaded });
  const port = await ctx.start();
  const base = `http://localhost:${port}/api/v1`;
  const call = async (path: string, init: RequestInit & { token?: string } = {}) => {
    const r = await fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) } });
    return { status: r.status, body: (await r.json()) as any };
  };
  const login = async (email: string, password = 'demo1234') => (await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).body.accessToken as string;
  return { ctx, call, login };
}

test('PostgreSQL: users and audit log survive a restart', { skip: !url && 'set TEST_DATABASE_URL to run' }, async () => {
  const a = await boot();
  assert.equal((await a.call('/health')).body.storage, 'postgres');
  const admin = await a.login('admin@demo.com');
  const op = await a.login('operator@demo.com');
  await a.call('/live/controller', { method: 'POST', token: op, body: JSON.stringify({ controller: 'fixed' }) });
  await a.call('/admin/users', { method: 'POST', token: admin, body: JSON.stringify({ email: 'pg@demo.com', name: 'Pg User', role: 'viewer', password: 'longenough1' }) });
  await a.ctx.close(); // waits for queued writes

  const b = await boot();
  const admin2 = await b.login('admin@demo.com');
  assert.ok(await b.login('pg@demo.com', 'longenough1'));
  const audit = (await b.call('/admin/audit?limit=500', { token: admin2 })).body as { action: string; id: number }[];
  assert.ok(audit.some((e) => e.action === 'switch_controller') && audit.some((e) => e.action === 'create_user'));
  assert.equal(new Set(audit.map((e) => e.id)).size, audit.length);
  assert.equal((await b.call('/admin/users', { token: admin2 })).body.length, 4);
  await b.ctx.close();
});
