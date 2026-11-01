import { mkdirSync, writeFileSync } from 'node:fs';
import { AdaptiveController, FixedTimeController, type AdaptiveOptions } from './controllers.js';
import { Simulation } from './sim.js';
import { SCENARIOS, type Controller, type Metrics } from './types.js';

const METRICS: { key: keyof Metrics; label: string; digits: number }[] = [
  { key: 'avgWaitPerVehicleS', label: 'Avg wait per vehicle (s)', digits: 1 },
  { key: 'avgQueue', label: 'Avg queue per approach (veh)', digits: 2 },
  { key: 'maxQueue', label: 'Max queue (veh)', digits: 0 },
  { key: 'stopsPerVehicle', label: 'Stops per vehicle', digits: 2 },
  { key: 'throughputPerHour', label: 'Throughput (veh/h)', digits: 0 },
  { key: 'co2Kg', label: 'Idling CO2 (kg)', digits: 1 },
];

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/** Average demand multiplier over the scenario, used to tune the strong fixed-time baseline. */
const avgDemand = (name: string) => {
  const s = SCENARIOS[name];
  let sum = 0;
  for (let t = 0; t < s.durationS; t++) sum += s.demand(t);
  return sum / s.durationS;
};

export interface Row {
  label: string;
  digits: number;
  fixed: number;
  tuned: number;
  adaptive: number;
  vsFixedPct: number;
  vsTunedPct: number;
}

export interface BenchmarkResult {
  scenario: string;
  seeds: number[];
  rows: Row[];
  winsVsFixed: number;
  winsVsTuned: number;
  wait: { fixed: number[]; tuned: number[]; adaptive: number[] };
}

export function runBenchmark(scenarioName: string, seeds: number[], adaptiveOptions: Partial<AdaptiveOptions> = {}): BenchmarkResult {
  const scenario = SCENARIOS[scenarioName];
  const makers: Record<'fixed' | 'tuned' | 'adaptive', () => Controller> = {
    fixed: () => FixedTimeController.equalSplit(),
    tuned: () => FixedTimeController.tunedFor(avgDemand(scenarioName)),
    adaptive: () => new AdaptiveController(adaptiveOptions),
  };
  const res: Record<'fixed' | 'tuned' | 'adaptive', Metrics[]> = { fixed: [], tuned: [], adaptive: [] };
  for (const seed of seeds) {
    for (const k of Object.keys(makers) as (keyof typeof makers)[]) {
      res[k].push(new Simulation({ seed, scenario, controller: makers[k]() }).run().metrics());
    }
  }
  const pct = (a: number, b: number) => ((a - b) / b) * 100;
  const rows: Row[] = METRICS.map((m) => {
    const f = mean(res.fixed.map((x) => x[m.key] as number));
    const t = mean(res.tuned.map((x) => x[m.key] as number));
    const a = mean(res.adaptive.map((x) => x[m.key] as number));
    return { label: m.label, digits: m.digits, fixed: f, tuned: t, adaptive: a, vsFixedPct: pct(a, f), vsTunedPct: pct(a, t) };
  });
  const wait = (k: keyof typeof res) => res[k].map((x) => x.avgWaitPerVehicleS);
  const wins = (k: 'fixed' | 'tuned') => seeds.filter((_, i) => wait('adaptive')[i] < wait(k)[i]).length;
  return { scenario: scenarioName, seeds, rows, winsVsFixed: wins('fixed'), winsVsTuned: wins('tuned'), wait: { fixed: wait('fixed'), tuned: wait('tuned'), adaptive: wait('adaptive') } };
}

const fmt = (n: number, d: number) => (d === 0 ? Math.round(n).toLocaleString('en-US') : n.toFixed(d));
const sgn = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;

export function toMarkdown(r: BenchmarkResult): string {
  const n = r.seeds.length;
  return [
    `### ${r.scenario}: ${SCENARIOS[r.scenario].description}`,
    `Mean of ${n} seeded runs (${r.seeds.join(', ')}), ${SCENARIOS[r.scenario].durationS} s each. Same traffic for every controller.`,
    '',
    '| Metric | Fixed (equal split) | Fixed (tuned) | Adaptive | vs fixed | vs tuned |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.rows.map((x) => `| ${x.label} | ${fmt(x.fixed, x.digits)} | ${fmt(x.tuned, x.digits)} | ${fmt(x.adaptive, x.digits)} | ${sgn(x.vsFixedPct)} | ${sgn(x.vsTunedPct)} |`),
    '',
    `Adaptive had the lower average wait in ${r.winsVsFixed}/${n} seeds vs fixed and ${r.winsVsTuned}/${n} vs tuned. ` +
      `Wait (s): fixed ${mean(r.wait.fixed).toFixed(1)} ± ${sd(r.wait.fixed).toFixed(1)}, tuned ${mean(r.wait.tuned).toFixed(1)} ± ${sd(r.wait.tuned).toFixed(1)}, adaptive ${mean(r.wait.adaptive).toFixed(1)} ± ${sd(r.wait.adaptive).toFixed(1)}.`,
    '',
  ].join('\n');
}

// Run as a script: npm run benchmark   (optional: --seeds=101..110)
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.find((a) => a.startsWith('--seeds='))?.slice(8);
  const [lo, hi] = arg ? arg.split('..').map(Number) : [1, 10];
  const seeds = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const results = Object.keys(SCENARIOS).map((name) => runBenchmark(name, seeds));
  const md = results.map(toMarkdown).join('\n');
  console.log(md);
  if (!arg) {
    mkdirSync('out', { recursive: true });
    writeFileSync('out/benchmark.md', md);
    writeFileSync('out/benchmark.json', JSON.stringify(results, null, 2));
    console.log('Saved out/benchmark.md and out/benchmark.json');
  }
}
