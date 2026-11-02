export interface AuditEntry {
  id: number;
  at: string;
  userId: string | null;
  user: string | null;
  action: string;
  details?: Record<string, unknown>;
}

/**
 * Audit log. Reads come from memory (the last 5000 entries); every new entry is also
 * handed to `sink`, which writes it to the database, so the log survives restarts.
 */
export class AuditLog {
  private entries: AuditEntry[];
  private nextId: number;

  constructor(initial: AuditEntry[] = [], private sink?: (e: AuditEntry) => void) {
    this.entries = initial.slice(-5000);
    this.nextId = initial.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  }

  add(actor: { id: string; email: string } | null, action: string, details?: Record<string, unknown>): void {
    const entry: AuditEntry = { id: this.nextId++, at: new Date().toISOString(), userId: actor?.id ?? null, user: actor?.email ?? null, action, details };
    this.entries.push(entry);
    if (this.entries.length > 5000) this.entries.shift();
    this.sink?.(entry);
  }

  list(filter: { action?: string; user?: string; limit?: number } = {}): AuditEntry[] {
    const out = this.entries.filter((e) => (!filter.action || e.action === filter.action) && (!filter.user || e.user === filter.user));
    return out.slice(-(filter.limit ?? 100)).reverse();
  }
}
