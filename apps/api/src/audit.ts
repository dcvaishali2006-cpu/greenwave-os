export interface AuditEntry {
  id: number;
  at: string;
  userId: string | null;
  user: string | null;
  action: string;
  details?: Record<string, unknown>;
}

/** In-memory audit log. Swap for the audit_logs table when PostgreSQL is wired in. */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private nextId = 1;

  add(actor: { id: string; email: string } | null, action: string, details?: Record<string, unknown>): void {
    this.entries.push({ id: this.nextId++, at: new Date().toISOString(), userId: actor?.id ?? null, user: actor?.email ?? null, action, details });
    if (this.entries.length > 5000) this.entries.shift();
  }

  list(filter: { action?: string; user?: string; limit?: number } = {}): AuditEntry[] {
    const out = this.entries.filter((e) => (!filter.action || e.action === filter.action) && (!filter.user || e.user === filter.user));
    return out.slice(-(filter.limit ?? 100)).reverse();
  }
}
