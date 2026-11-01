'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiFail, api } from '@/lib/api';
import { fmtClock } from '@/lib/corridor';
import { CONTROLLERS, SCENARIOS, type ControllerName, type ForkResponse, type LiveStatus } from '@/lib/types';

const LINE: Record<ControllerName, string> = { fixed: '#F59E0B', 'fixed-tuned': '#38BDF8', adaptive: '#8B5CF6' };
const LABEL: Record<ControllerName, string> = { fixed: 'Fixed', 'fixed-tuned': 'Fixed (tuned)', adaptive: 'Adaptive' };
const WINDOWS = [
  { s: 900, label: '15 min' },
  { s: 1500, label: '25 min' },
  { s: 2400, label: '40 min' },
  { s: 3600, label: 'To the end of the hour' },
];
const signed = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(0)}%`;

const W = 640;
const H = 230;
const PAD = { l: 36, r: 84, t: 12, b: 26 };

/** Queue over time for every branch: dashed line = what would have happened with no change. */
function Chart({ r, hover, setHover }: { r: ForkResponse; hover: number | null; setHover: (i: number | null) => void }) {
  const n = r.branches[0].series.length;
  const max = Math.max(10, ...r.branches.flatMap((b) => b.series.map((p) => p.totalQueue)));
  const top = Math.ceil(max / 10) * 10;
  const t0 = r.branches[0].series[0].t;
  const t1 = r.branches[0].series[n - 1].t;
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(top * f));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Vehicles waiting in the network over time, one line per controller"
      className="w-full touch-none select-none"
      onPointerMove={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - box.left) / box.width) * W;
        const f = (px - PAD.l) / (W - PAD.l - PAD.r);
        setHover(Math.max(0, Math.min(n - 1, Math.round(f * (n - 1)))));
      }}
      onPointerLeave={() => setHover(null)}
    >
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#1F2A44" strokeWidth="1" />
          <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="#94A3B8">{v}</text>
        </g>
      ))}
      {[0, 0.5, 1].map((f) => {
        const t = Math.round(t0 + (t1 - t0) * f);
        return <text key={f} x={x(t)} y={H - 8} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'} fontSize="10" fill="#94A3B8">{fmtClock(t)}</text>;
      })}
      {r.branches.map((b) => {
        const d = b.series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.totalQueue).toFixed(1)}`).join(' ');
        const last = b.series[b.series.length - 1];
        return (
          <g key={b.controller}>
            <path d={d} fill="none" stroke={LINE[b.controller]} strokeWidth={b.controller === 'adaptive' ? 2.5 : 2} strokeDasharray={b.unchanged ? '6 4' : undefined} strokeLinejoin="round" />
            <text x={W - PAD.r + 5} y={y(last.totalQueue) + 3} fontSize="10" fontWeight="600" fill={LINE[b.controller]}>{LABEL[b.controller]}</text>
          </g>
        );
      })}
      {hover !== null && (
        <line x1={x(r.branches[0].series[hover].t)} x2={x(r.branches[0].series[hover].t)} y1={PAD.t} y2={H - PAD.b} stroke="#E5E7EB" strokeOpacity="0.5" strokeWidth="1" />
      )}
    </svg>
  );
}

/** Time Machine: rewind to a moment, hand the signals to each controller, compare on identical traffic. */
export default function TimeMachine({ status, onClose }: { status: LiveStatus | null; onClose: () => void }) {
  const [scenario, setScenario] = useState(status?.scenario ?? 'incident');
  const [history, setHistory] = useState<ControllerName>('fixed');
  const [atMin, setAtMin] = useState(scenario === 'incident' ? 20 : 15);
  const [windowS, setWindowS] = useState(2400);
  const [data, setData] = useState<ForkResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hover, setHover] = useState<number | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const seed = status?.seed ?? 1;

  // The parent re-renders every second (live data) and hands us a new onClose each time, so keep it in a ref:
  // an effect that depended on it would re-run every second and steal focus from the dropdown being used.
  const closeFn = useRef(onClose);
  closeFn.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeFn.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run = async () => {
    setBusy(true);
    setError('');
    setHover(null);
    try {
      setData(await api<ForkResponse>(`/timemachine/fork?scenario=${scenario}&seed=${seed}&at=${atMin * 60}&window=${windowS}&history=${history}&seeds=5`));
    } catch (e) {
      setData(null);
      setError(e instanceof ApiFail ? e.message : 'Could not run the Time Machine.');
    } finally {
      setBusy(false);
    }
  };

  const verdict = useMemo(() => {
    if (!data) return null;
    const alts = data.robustness.branches.filter((b) => !b.unchanged);
    const best = alts.reduce((a, b) => (b.meanVsUnchangedPct < a.meanVsUnchangedPct ? b : a));
    const n = data.robustness.seeds.length;
    const when = fmtClock(data.atS);
    const win = `${Math.round(data.windowS / 60)} min`;
    if (best.meanVsUnchangedPct <= -5 && best.wins >= Math.ceil(n * 0.7)) {
      return { tone: 'good' as const, text: `Switching to ${LABEL[best.controller]} at ${when} would have cut waiting by ${Math.abs(best.meanVsUnchangedPct).toFixed(0)}% over the next ${win}.`, detail: `Better than the original plan in ${best.wins} of ${n} seeded runs.` };
    }
    const worst = alts.reduce((a, b) => (b.meanVsUnchangedPct > a.meanVsUnchangedPct ? b : a));
    if (alts.every((b) => b.meanVsUnchangedPct >= 5)) {
      return { tone: 'bad' as const, text: `Changing controllers at ${when} would have made waiting worse over the next ${win} (${LABEL[worst.controller]} ${signed(worst.meanVsUnchangedPct)}).`, detail: 'Over this window the original plan was the better choice. This is a real result, not a fault: a controller that reacts to demand needs time to pay back.' };
    }
    return { tone: 'neutral' as const, text: `No clear difference over the next ${win}: the best change (${LABEL[best.controller]}) is ${signed(best.meanVsUnchangedPct)} against the original plan, and wins in ${best.wins} of ${n} runs.`, detail: 'Try a longer window or an earlier fork time to see where a change starts to matter.' };
  }, [data]);

  const best = data?.branches.find((b) => b.controller === data.best);
  const shownAlt = data ? data.branches.filter((b) => !b.unchanged).reduce((a, b) => (b.avgWaitPerVehicleS < a.avgWaitPerVehicleS ? b : a)) : null;
  const point = data && hover !== null ? data.branches.map((b) => ({ c: b.controller, v: b.series[hover]?.totalQueue ?? 0, t: b.series[hover]?.t ?? 0 })) : null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-start justify-center overflow-y-auto bg-ink/85 p-3 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="tm-title" className="w-full max-w-4xl rounded-2xl border border-line bg-panel shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3 sm:px-5">
          <div>
            <h2 id="tm-title" className="text-base font-bold text-text">Time Machine</h2>
            <p className="mt-0.5 text-xs text-muted">Rewind to any moment, give the signals to another controller from there, and compare with what really happened. Same hour, same cars, same seed: only the signals differ.</p>
          </div>
          <button ref={closeRef} onClick={onClose} aria-label="Close Time Machine" className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-text">Close</button>
        </div>

        <div className="grid gap-3 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
          <label className="text-xs text-muted">
            Scenario
            <select value={scenario} onChange={(e) => { setScenario(e.target.value); setAtMin(e.target.value === 'incident' ? 20 : 15); }} className="mt-1 w-full rounded-lg border border-line bg-ink px-2 py-1.5 text-xs text-text">
              {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted">
            Signals before the fork
            <select value={history} onChange={(e) => setHistory(e.target.value as ControllerName)} className="mt-1 w-full rounded-lg border border-line bg-ink px-2 py-1.5 text-xs text-text">
              {CONTROLLERS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted">
            Rewind to <b className="font-mono text-text">{String(atMin).padStart(2, '0')}:00</b>
            <input type="range" min={0} max={58} value={atMin} onChange={(e) => setAtMin(Number(e.target.value))} aria-label="Fork time in minutes" className="mt-2 w-full accent-ai" />
          </label>
          <label className="text-xs text-muted">
            Compare the next
            <select value={windowS} onChange={(e) => setWindowS(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-line bg-ink px-2 py-1.5 text-xs text-text">
              {WINDOWS.map((w) => <option key={w.s} value={w.s}>{w.label}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-4 pb-4 sm:px-5">
          <button onClick={run} disabled={busy} className="rounded-lg bg-ai px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60">{busy ? 'Running 3 timelines...' : 'Run the Time Machine'}</button>
          <span className="text-[11px] text-muted">Seed {seed}. {scenario === 'incident' ? 'The blocked lane starts at 20:00 and clears at 35:00.' : 'Try the incident scenario to see where adaptive control matters most.'}</span>
        </div>

        {error && <p role="alert" className="mx-4 mb-4 rounded-lg border border-stop/40 bg-stop/10 px-3 py-2 text-xs text-stop sm:mx-5">{error}</p>}
        {busy && !data && <div className="mx-4 mb-4 h-48 animate-pulse rounded-xl bg-raised sm:mx-5" aria-busy="true" />}

        {data && verdict && (
          <div className="space-y-4 border-t border-line px-4 py-4 sm:px-5" aria-live="polite">
            <div className={`rounded-xl border px-4 py-3 ${verdict.tone === 'good' ? 'border-go/40 bg-go/10' : verdict.tone === 'bad' ? 'border-stop/40 bg-stop/10' : 'border-line bg-ink'}`}>
              <p className="text-sm font-semibold text-text">{verdict.text}</p>
              <p className="mt-1 text-xs text-muted">{verdict.detail}</p>
            </div>

            <div>
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Vehicles waiting in the whole network</h3>
                <span className="text-[11px] text-muted">Dashed line: what happened with {LABEL[data.history]} (no change)</span>
              </div>
              <div className="rounded-xl bg-ink p-2">
                <div className="min-h-[18px] px-2 font-mono text-[11px] text-muted">
                  {point ? <>{fmtClock(point[0].t)} {point.map((p) => <span key={p.c} className="ml-3" style={{ color: LINE[p.c] }}>{LABEL[p.c]} {p.v}</span>)}</> : 'Move over the chart to read values.'}
                </div>
                <Chart r={data} hover={hover} setHover={setHover} />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-xs">
                <caption className="mb-1 text-left text-xs font-semibold uppercase tracking-wide text-muted">From {fmtClock(data.atS)} to {fmtClock(data.atS + data.windowS)}, seed {data.seed}</caption>
                <thead className="text-muted">
                  <tr><th className="py-1 pr-3 font-medium">Controller</th><th className="py-1 pr-3 font-medium">Avg wait</th><th className="py-1 pr-3 font-medium">vs no change</th><th className="py-1 pr-3 font-medium">Avg queue</th><th className="py-1 pr-3 font-medium">Max queue</th><th className="py-1 pr-3 font-medium">Stops / vehicle</th><th className="py-1 font-medium">Mean over {data.robustness.seeds.length} seeds</th></tr>
                </thead>
                <tbody>
                  {data.branches.map((b) => {
                    const rb = data.robustness.branches.find((x) => x.controller === b.controller)!;
                    return (
                      <tr key={b.controller} className="border-t border-line text-text">
                        <td className="py-1.5 pr-3 font-semibold"><span className="mr-2 inline-block h-2 w-3 rounded" style={{ background: LINE[b.controller] }} />{LABEL[b.controller]}{b.unchanged && <span className="ml-2 font-normal text-muted">(no change)</span>}</td>
                        <td className="py-1.5 pr-3 font-mono">{b.avgWaitPerVehicleS.toFixed(1)} s</td>
                        <td className="py-1.5 pr-3 font-mono">{b.unchanged ? '--' : signed(b.vsUnchangedPct)}</td>
                        <td className="py-1.5 pr-3 font-mono">{b.avgQueue.toFixed(1)}</td>
                        <td className="py-1.5 pr-3 font-mono">{b.maxQueue}</td>
                        <td className="py-1.5 pr-3 font-mono">{b.stopsPerVehicle.toFixed(2)}</td>
                        <td className="py-1.5 font-mono text-muted">{b.unchanged ? '--' : `${signed(rb.meanVsUnchangedPct)}, better in ${rb.wins} of ${data.robustness.seeds.length}`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {shownAlt && shownAlt.firstDecisions.length > 0 && (
              <div>
                <h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-text"><span className="rounded bg-ai/20 px-1.5 py-px text-[10px] uppercase text-ai">Why?</span> First signal changes after the fork ({LABEL[shownAlt.controller]})</h3>
                <ul className="space-y-1.5">
                  {shownAlt.firstDecisions.map((d, i) => (
                    <li key={i} className="text-xs leading-snug text-muted"><span className="mr-1 font-mono text-text">{d.junctionId} {fmtClock(d.t)}</span>{d.reason}</li>
                  ))}
                </ul>
              </div>
            )}
            {best && <p className="text-[11px] text-muted">Every timeline replays the same hour from the same seed, and shares the identical past up to {fmtClock(data.atS)} ({data.branches[0].atFork.entered} vehicles had entered, {data.branches[0].atFork.totalQueue} were waiting).</p>}
          </div>
        )}
      </div>
    </div>
  );
}
