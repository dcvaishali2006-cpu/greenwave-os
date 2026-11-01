'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { EmergencyResult, EmergencyRun, LiveStatus } from '@/lib/types';

const SEEDS = 5;
const dirLabel = (r: EmergencyRun) => (r.dir === 'EB' ? 'J1 to J5' : 'J5 to J1');

/** Ambulance trips on the live run, plus the measured benefit of signal priority over several seeded runs. */
export default function EmergencyPanel({ status }: { status: LiveStatus | null }) {
  const scenario = status?.scenario ?? 'normal';
  const controller = status?.controller ?? 'adaptive';
  const [data, setData] = useState<EmergencyResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(false);
    api<EmergencyResult>(`/analytics/emergency?scenario=${scenario}&controller=${controller}&seeds=${SEEDS}`)
      .then((r) => alive && setData(r))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [scenario, controller]);

  const runs = [...(status?.emergencyRuns ?? [])].reverse();
  const cost = data?.trafficWaitCostPct ?? 0;

  return (
    <section aria-label="Emergency vehicle corridor" className="rounded-xl border border-line bg-panel p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">Emergency corridor</h2>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${(status?.priority ?? true) ? 'bg-stop/15 text-stop' : 'bg-raised text-muted'}`}>priority {(status?.priority ?? true) ? 'on' : 'off'}</span>
      </div>
      <p className="mt-1 text-[11px] text-muted">Send an ambulance from the top bar. With priority on, signals ahead of it turn green in time. Try it once with priority off to see the difference.</p>

      {runs.length === 0 ? (
        <p className="mt-2 rounded-lg border border-dashed border-line px-3 py-2 text-xs text-muted">No ambulance has run yet.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {runs.map((r) => (
            <li key={r.id} className="rounded-lg bg-ink px-3 py-2 text-xs">
              <div className="flex items-baseline justify-between">
                <span className="font-mono font-bold text-text">{r.id} <span className="font-sans font-normal text-muted">{dirLabel(r)}</span></span>
                <span className={r.priority ? 'text-stop' : 'text-muted'}>{r.priority ? 'priority' : 'no priority'}</span>
              </div>
              {r.status === 'done' ? (
                <div className="mt-0.5 text-muted">
                  <b className="text-text">{r.journeyS} s</b> trip, {r.delayS! <= 0 ? 'no delay' : `${r.delayS} s slower than free flow (${r.freeFlowS} s)`}, {r.stops === 0 ? 'no stops' : `${r.stops} stop${r.stops > 1 ? 's' : ''} (${r.waitedS} s at red)`}
                </div>
              ) : (
                <div className="mt-0.5 text-muted">{r.status === 'waiting' ? 'Waiting at a red signal' : 'On its way'}... stops so far {r.stops}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 border-t border-line pt-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Measured, {SEEDS} seeded runs, 4 ambulances each</h3>
        {!data && !failed && <div className="mt-2 h-10 animate-pulse rounded-lg bg-raised" aria-busy="true" />}
        {failed && <p className="mt-2 text-xs text-stop">Could not load the measurement.</p>}
        {data && (
          <p className="mt-1.5 text-xs leading-snug text-muted">
            With the current controller and scenario, an ambulance trip takes <b className="text-text">{data.without.journeyS.toFixed(0)} s</b> without priority and <b className="text-text">{data.with.journeyS.toFixed(0)} s</b> with it
            ({data.without.stops.toFixed(1)} stops down to {data.with.stops.toFixed(1)}). The price: everyone else waits{' '}
            <b className="text-text">{Math.abs(cost) < 0.5 ? 'about the same' : `${cost > 0 ? '+' : ''}${cost.toFixed(0)}%`}</b> {Math.abs(cost) < 0.5 ? '' : 'on average'} while the signals favour the ambulance.
          </p>
        )}
      </div>
    </section>
  );
}
