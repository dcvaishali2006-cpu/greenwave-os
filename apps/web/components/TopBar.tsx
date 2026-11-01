'use client';
import { useState } from 'react';
import { ApiFail, api, type User } from '@/lib/api';
import { fmtClock } from '@/lib/corridor';
import { CONTROLLERS, SCENARIOS, type ControllerName, type LiveStatus } from '@/lib/types';

export default function TopBar({ user, status, connected, onChanged, onLogout }: { user: User; status: LiveStatus | null; connected: boolean; onChanged: () => void; onLogout: () => void }) {
  const [error, setError] = useState('');
  const canControl = user.role === 'operator' || user.role === 'admin';

  const act = async (path: string, body: unknown) => {
    setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      onChanged();
    } catch (e) {
      setError(e instanceof ApiFail ? e.message : 'Action failed.');
    }
  };

  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-panel px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-go shadow-[0_0_10px_#22C55E]" />
        <span className="text-base font-bold text-text">GreenWave OS</span>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted" title={connected ? 'Live stream connected' : 'Reconnecting...'}>
        <span className={`h-2 w-2 rounded-full ${connected ? 'bg-go' : 'animate-pulse bg-slow'}`} />
        {connected ? 'Live' : 'Reconnecting'}
        {status && <span className="font-mono text-text">{fmtClock(status.time)}</span>}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Control</span>
        <div role="group" aria-label="Signal controller" className="inline-flex overflow-hidden rounded-lg border border-line">
          {CONTROLLERS.map((c) => {
            const active = status?.controller === c.id;
            return (
              <button
                key={c.id}
                title={canControl ? c.hint : 'Operators and admins only'}
                disabled={!canControl}
                aria-pressed={active}
                onClick={() => act('/live/controller', { controller: c.id as ControllerName })}
                className={`px-3 py-1.5 text-xs font-semibold transition ${active ? (c.id === 'adaptive' ? 'bg-ai text-white' : 'bg-raised text-text ring-1 ring-inset ring-slow') : 'bg-ink text-muted hover:text-text'} disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted">
        Scenario
        <select
          value={status?.scenario ?? 'normal'}
          disabled={!canControl}
          onChange={(e) => act('/live/scenario', { scenario: e.target.value })}
          className="rounded-lg border border-line bg-ink px-2 py-1.5 text-xs text-text disabled:cursor-not-allowed disabled:opacity-60"
        >
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Ambulance</span>
        <div role="group" aria-label="Dispatch ambulance" className="inline-flex overflow-hidden rounded-lg border border-line">
          {([['EB', 'J1 to J5'], ['WB', 'J5 to J1']] as const).map(([dir, label]) => (
            <button
              key={dir}
              disabled={!canControl}
              title={canControl ? `Send an ambulance from ${label.replace(' to ', ' to ')}` : 'Operators and admins only'}
              onClick={() => act('/live/emergency', { direction: dir })}
              className="bg-ink px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
            >
              {label}
            </button>
          ))}
        </div>
        <button
          disabled={!canControl}
          aria-pressed={status?.priority ?? true}
          title={canControl ? 'Signal priority for ambulances: on gives them green lights, off treats them like other traffic' : 'Operators and admins only'}
          onClick={() => act('/live/emergency/priority', { enabled: !(status?.priority ?? true) })}
          className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${(status?.priority ?? true) ? 'border-stop/60 bg-stop/15 text-stop' : 'border-line bg-ink text-muted'}`}
        >
          Priority {(status?.priority ?? true) ? 'on' : 'off'}
        </button>
      </div>

      {error && <span role="alert" className="text-xs text-stop">{error}</span>}

      <div className="ml-auto flex items-center gap-3">
        <span className="text-right text-xs leading-tight">
          <span className="block font-semibold text-text">{user.name}</span>
          <span className="block capitalize text-muted">{user.role === 'viewer' ? 'monitoring (read-only)' : user.role}</span>
        </span>
        <button onClick={onLogout} className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-text">Sign out</button>
      </div>
    </header>
  );
}
