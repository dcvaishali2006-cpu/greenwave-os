import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuditEntry } from './audit.js';
import type { User } from './auth.js';

/**
 * Where users and the audit log live. Reads happen once at start-up; writes are
 * handed over as they happen. Three backends, picked by openStorage():
 *   postgres  when DATABASE_URL is set (for hosting)
 *   sqlite    a single file, the default on a laptop (no install needed)
 *   memory    nothing is kept (tests, or DB=memory)
 */
export interface Storage {
  kind: 'memory' | 'sqlite' | 'postgres';
  load(): Promise<{ users: User[]; audit: AuditEntry[] }>;
  saveUser(u: User): void;
  appendAudit(e: AuditEntry): void;
  close(): Promise<void>;
}

export class MemoryStorage implements Storage {
  kind = 'memory' as const;
  async load() { return { users: [], audit: [] }; }
  saveUser() {}
  appendAudit() {}
  async close() {}
}

const AUDIT_KEEP = 5000;

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): any[] };
  close(): void;
}

export class SqliteStorage implements Storage {
  kind = 'sqlite' as const;
  private constructor(private db: SqliteDb) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id TEXT, user_email TEXT, action TEXT NOT NULL, details TEXT);
    `);
  }

  static async open(file: string): Promise<SqliteStorage> {
    const mod = await import('better-sqlite3');
    const Database = mod.default as unknown as new (f: string) => SqliteDb;
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file);
    (db as unknown as { pragma(s: string): void }).pragma('journal_mode = WAL');
    return new SqliteStorage(db);
  }

  async load() {
    const users = this.db.prepare('SELECT id, email, name, role, password_hash AS passwordHash FROM users ORDER BY rowid').all() as User[];
    const rows = this.db.prepare('SELECT id, at, user_id AS userId, user_email AS user, action, details FROM audit_logs ORDER BY id DESC LIMIT ?').all(AUDIT_KEEP);
    const audit: AuditEntry[] = rows.reverse().map((r) => ({ id: r.id, at: r.at, userId: r.userId, user: r.user, action: r.action, ...(r.details ? { details: JSON.parse(r.details) } : {}) }));
    return { users, audit };
  }

  saveUser(u: User) {
    this.db.prepare('INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, role=excluded.role, password_hash=excluded.password_hash').run(u.id, u.email, u.name, u.role, u.passwordHash);
  }

  appendAudit(e: AuditEntry) {
    this.db.prepare('INSERT INTO audit_logs (id, at, user_id, user_email, action, details) VALUES (?, ?, ?, ?, ?, ?)').run(e.id, e.at, e.userId, e.user, e.action, e.details ? JSON.stringify(e.details) : null);
  }

  async close() { this.db.close(); }
}

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  end(): Promise<void>;
}

export class PostgresStorage implements Storage {
  kind = 'postgres' as const;
  /** Writes run one after another so the audit order is kept. */
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private pool: PgPool) {}

  static async open(url: string): Promise<PostgresStorage> {
    const pg = await import('pg');
    const Pool = (pg.default?.Pool ?? (pg as unknown as { Pool: new (o: unknown) => PgPool }).Pool) as new (o: unknown) => PgPool;
    // Hosted databases usually need TLS; local ones do not.
    const local = /@(localhost|127\.0\.0\.1)/.test(url);
    const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 4 });
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (id BIGINT PRIMARY KEY, at TIMESTAMPTZ NOT NULL, user_id TEXT, user_email TEXT, action TEXT NOT NULL, details JSONB)`);
    return new PostgresStorage(pool);
  }

  async load() {
    const u = await this.pool.query('SELECT id, email, name, role, password_hash AS "passwordHash" FROM users ORDER BY email');
    const a = await this.pool.query(`SELECT id, at, user_id AS "userId", user_email AS "user", action, details FROM audit_logs ORDER BY id DESC LIMIT ${AUDIT_KEEP}`);
    const audit: AuditEntry[] = a.rows.reverse().map((r) => ({ id: Number(r.id), at: new Date(r.at).toISOString(), userId: r.userId, user: r.user, action: r.action, ...(r.details ? { details: r.details } : {}) }));
    return { users: u.rows as User[], audit };
  }

  private enqueue(sql: string, params: unknown[]) {
    this.queue = this.queue.then(() => this.pool.query(sql, params)).catch((err) => console.error('Database write failed:', (err as Error).message));
  }

  saveUser(u: User) {
    this.enqueue('INSERT INTO users (id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, name=EXCLUDED.name, role=EXCLUDED.role, password_hash=EXCLUDED.password_hash', [u.id, u.email, u.name, u.role, u.passwordHash]);
  }

  appendAudit(e: AuditEntry) {
    this.enqueue('INSERT INTO audit_logs (id, at, user_id, user_email, action, details) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING', [e.id, e.at, e.userId, e.user, e.action, e.details ? JSON.stringify(e.details) : null]);
  }

  async close() {
    await this.queue;
    await this.pool.end();
  }
}

const DEFAULT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'greenwave.db');

/** Chooses the backend from the environment. A missing SQLite module falls back to memory with a warning; a bad DATABASE_URL stops the server. */
export async function openStorage(env: NodeJS.ProcessEnv = process.env): Promise<Storage> {
  if (env.DB === 'memory') return new MemoryStorage();
  if (env.DATABASE_URL) return PostgresStorage.open(env.DATABASE_URL);
  try {
    return await SqliteStorage.open(env.DB_PATH ?? DEFAULT_FILE);
  } catch (e) {
    console.warn(`SQLite is not available (${(e as Error).message}). Running without a database: users and audit log reset on restart.`);
    return new MemoryStorage();
  }
}
