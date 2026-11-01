'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtClock, queueColor } from '@/lib/corridor';
import type { Dir, JunctionState, LoggedDecision } from '@/lib/types';

const LABEL: Record<Dir, string> = { EB: 'Eastbound', WB: 'Westbound', NB: 'Northbound', SB: 'Southbound' };
const ORDER: Dir[] = ['EB', 'WB', 'NB', 'SB'];

export default function JunctionPanel({ junction, onClose }: { junction: JunctionState; onClose: () => void }) {
  const [why, setWhy] = useState<LoggedDecision[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => api<{ decisions: LoggedDecision[] }>(`/junctions/${junction.id}/why?limit=4`).then((r) => alive && setWhy(r.decisions)).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [junction.id]);

  const phaseName = junction.phase === 0 ? 'East-West' : 'North-South';
  const lamp = junction.mode === 'green' ? `${phaseName} green for ${junction.greenElapsed} s` : `${phaseName} clearing (amber, then all red)`;

  return (
    <section aria-label={`Details for ${junction.id}`} className="rounded-xl border border-ai/50 bg-panel">
      <div className="flex items-start justify-between border-b border-line px-3 py-2">
        <div>
          <h2 className="text-sm font-semibold text-text">Junction {junction.id.slice(1)}</h2>
          <p className="text-xs text-muted">{lamp}</p>
        </div>
        <button onClick={onClose} aria-label="Close junction details" className="rounded px-2 py-1 text-xs text-muted hover:text-text">Close</button>
      </div>

      <div className="space-y-2 px-3 py-3">
        {ORDER.map((d) => {
          const a = junction.approaches[d];
          return (
            <div key={d}>
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-text">{LABEL[d]}</span>
                <span className="font-mono text-muted">
                  <b className="text-text">{a.queue}</b> waiting{a.upcoming > 0 && <span className="text-ai"> +{a.upcoming} due</span>} <span className="opacity-60">| {(a.flowRate * 60).toFixed(1)} veh/min</span>
                </span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink">
                <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(100, (a.queue / 30) * 100)}%`, background: queueColor(a.queue) }} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-line px-3 py-3">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-text">
          <span className="rounded bg-ai/20 px-1.5 py-px text-[10px] uppercase text-ai">Why?</span> Latest decisions here
        </h3>
        {why.length === 0 && <p className="text-xs text-muted">No decisions yet.</p>}
        <ul className="space-y-2">
          {why.map((d, i) => (
            <li key={`${d.t}-${i}`} className="text-xs leading-snug text-muted">
              <span className="mr-1 font-mono text-text">{fmtClock(d.t)}</span>
              {d.reason}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
