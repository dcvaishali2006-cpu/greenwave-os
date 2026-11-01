import { fmtClock } from '@/lib/corridor';
import type { FeedItem } from '@/lib/live';

export default function DecisionFeed({ feed, onPick }: { feed: FeedItem[]; onPick: (id: string) => void }) {
  return (
    <section aria-label="Live signal decisions" className="rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="text-sm font-semibold text-text">Why the signals changed</h2>
        <span className="rounded-full bg-ai/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ai">live</span>
      </div>
      <ul className="max-h-72 divide-y divide-line overflow-y-auto">
        {feed.length === 0 && <li className="px-3 py-4 text-xs text-muted">Waiting for the next signal change...</li>}
        {feed.map((d) => (
          <li key={d.key} className="px-3 py-2">
            <button onClick={() => onPick(d.junctionId)} className="block w-full text-left">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-mono font-bold text-text">{d.junctionId}</span>
                <span className="font-mono text-muted">{fmtClock(d.t)}</span>
                <span className={`rounded px-1.5 py-px text-[10px] font-semibold uppercase ${d.controller === 'emergency' ? 'bg-stop/20 text-stop' : d.kind === 'hold' ? 'bg-ai/20 text-ai' : 'bg-raised text-muted'}`}>{d.controller === 'emergency' ? 'ambulance' : d.kind === 'hold' ? 'green wave' : d.controller}</span>
              </div>
              <p className="mt-1 text-xs leading-snug text-muted">{d.reason}</p>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
