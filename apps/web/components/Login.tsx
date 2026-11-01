'use client';
import { useState } from 'react';
import { ApiFail, login, type User } from '@/lib/api';

const DEMO = [
  { email: 'admin@demo.com', role: 'Administrator', note: 'Everything, including audit log' },
  { email: 'operator@demo.com', role: 'Operator', note: 'Monitor and control signals' },
  { email: 'viewer@demo.com', role: 'Monitoring', note: 'Read-only' },
];

export default function Login({ onDone }: { onDone: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const go = async (e: string, p: string) => {
    setBusy(true);
    setError('');
    try {
      onDone(await login(e, p));
    } catch (err) {
      setError(err instanceof ApiFail ? err.message : 'Cannot reach the API. Is it running on port 4000?');
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink px-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-7 shadow-2xl">
        <div className="mb-1 flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-go/15">
            <span className="h-2.5 w-2.5 rounded-full bg-go shadow-[0_0_10px_#22C55E]" />
          </span>
          <h1 className="text-xl font-bold text-text">GreenWave OS</h1>
        </div>
        <p className="mb-6 text-sm text-muted">Traffic control room that explains every signal decision.</p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            go(email, password);
          }}
          className="space-y-3"
        >
          <label className="block text-xs font-medium text-muted">
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" className="mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm text-text outline-none focus:border-ai" />
          </label>
          <label className="block text-xs font-medium text-muted">
            Password
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm text-text outline-none focus:border-ai" />
          </label>
          <button disabled={busy} className="w-full rounded-lg bg-ai px-3 py-2 text-sm font-semibold text-white hover:bg-ai/90 disabled:opacity-60">
            {busy ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        {error && <p role="alert" className="mt-3 rounded-lg border border-stop/40 bg-stop/10 px-3 py-2 text-sm text-stop">{error}</p>}

        <div className="mt-6 border-t border-line pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Demo accounts for judges</p>
          <div className="space-y-2">
            {DEMO.map((d) => (
              <button key={d.email} disabled={busy} onClick={() => go(d.email, 'demo1234')} className="flex w-full items-center justify-between rounded-lg border border-line bg-raised px-3 py-2 text-left hover:border-ai disabled:opacity-60">
                <span>
                  <span className="block text-sm font-semibold text-text">{d.role}</span>
                  <span className="block text-xs text-muted">{d.note}</span>
                </span>
                <span className="font-mono text-[11px] text-muted">{d.email}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
