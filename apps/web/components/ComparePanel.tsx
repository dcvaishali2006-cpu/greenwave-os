'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { SCENARIOS, type CompareResult } from '@/lib/types';

const SEEDS = 5;

/** Adaptive vs fixed over several seeded runs of the current scenario. Computed on the server, then cached. */
export default function ComparePanel({ scenario }: { scenario: string }) {
  const [data, setData] = useState<CompareResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(false);
    api<CompareResult>(`/analytics/compare?scenario=${scenario}&seeds=${SEEDS}`)
      .then((r) => alive && setData(r))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [scenario]);

  const wait = data?.rows.find((r) => r.label.startsWith('Avg wait'));
  const bars = wait
    ? [
        { name: 'Fixed (equal split)', v: wait.fixed, color: '#64748B' },
        { name: 'Fixed (tuned)', v: wait.tuned, color: '#94A3B8' },
        { name: 'Adaptive', v: wait.adaptive, color: '#8B5CF6' },
      ]
    : [];
  const max = Math.max(1, ...bars.map((b) => b.v));
  const pct = wait?.vsFixedPct ?? 0;
  const finding = !wait ? '' : pct <= -5 ? `Adaptive cuts waiting by ${Math.abs(pct).toFixed(0)}% against the fixed plan` : pct >= 5 ? `Adaptive waits ${pct.toFixed(0)}% longer than the fixed plan here` : 'Adaptive ties the fixed plan in this scenario';
  const label = SCENARIOS.find((s) => s.id === scenario)?.label ?? scenario;

  return (
    <section aria-label="Adaptive versus fixed comparison" className="rounded-xl border border-line bg-panel p-3">
      <h2 className="text-sm font-semibold text-text">Adaptive vs fixed-time</h2>
      <p className="text-[11px] text-muted">{label}: average wait per vehicle, mean of {SEEDS} seeded runs on identical traffic</p>

      {!data && !failed && <div className="mt-3 h-24 animate-pulse rounded-lg bg-raised" aria-busy="true" />}
      {failed && <p className="mt-3 text-xs text-stop">Could not load the comparison.</p>}

      {wait && (
        <>
          <p className="mt-2 text-sm font-semibold text-text">{finding}</p>
          <div className="mt-2 space-y-2">
            {bars.map((b) => (
              <div key={b.name}>
                <div className="flex justify-between text-[11px] text-muted"><span>{b.name}</span><span className="font-mono text-text">{b.v.toFixed(1)} s</span></div>
                <div className="mt-0.5 h-2.5 overflow-hidden rounded-full bg-ink"><div className="h-full rounded-full" style={{ width: `${(b.v / max) * 100}%`, background: b.color }} /></div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted">Lower wait in {data!.winsVsFixed} of {SEEDS} runs vs fixed, {data!.winsVsTuned} of {SEEDS} vs tuned.</p>
        </>
      )}
    </section>
  );
}
