import type { LiveStatus } from '@/lib/types';

const Card = ({ label, value, unit, hint }: { label: string; value: string; unit: string; hint: string }) => (
  <div className="rounded-xl border border-line bg-panel p-3" title={hint}>
    <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
    <div className="mt-1 flex items-baseline gap-1">
      <span className="font-mono text-2xl font-bold tabular-nums text-text">{value}</span>
      <span className="text-xs text-muted">{unit}</span>
    </div>
  </div>
);

export default function Kpis({ status }: { status: LiveStatus | null }) {
  const m = status?.metrics;
  const dash = '--';
  return (
    <section aria-label="Key numbers for this run" className="grid grid-cols-2 gap-2">
      <Card label="Avg wait" value={m ? m.avgWaitPerVehicleS.toFixed(1) : dash} unit="s / vehicle" hint="Queue delay per vehicle that entered the network, this run so far" />
      <Card label="Avg queue" value={m ? m.avgQueue.toFixed(1) : dash} unit="veh / approach" hint="Average vehicles waiting on each approach" />
      <Card label="Throughput" value={m ? Math.round(m.throughputPerHour).toLocaleString('en-US') : dash} unit="veh / h" hint="Vehicles that left the network, scaled to an hour" />
      <Card label="Idling CO2" value={m ? m.co2Kg.toFixed(0) : dash} unit="kg" hint="Estimated from seconds spent idling (approximate)" />
    </section>
  );
}
