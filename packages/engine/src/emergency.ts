import { writeFileSync, mkdirSync } from 'node:fs';
import { AdaptiveController, FixedTimeController } from './controllers.js';
import { Simulation } from './sim.js';
import { SCENARIOS, type Controller } from './types.js';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const avgDemand = (name: string) => {
  const s = SCENARIOS[name];
  let sum = 0;
  for (let t = 0; t < s.durationS; t++) sum += s.demand(t);
  return sum / s.durationS;
};

export interface EmergencyResult {
  scenario: string;
  controller: string;
  seeds: number[];
  trips: number;
  without: { journeyS: number; delayS: number; stops: number; waitedS: number };
  with: { journeyS: number; delayS: number; stops: number; waitedS: number };
  /** Cost to everyone else: change in average wait per vehicle (seconds) when priority is on. */
  trafficWaitCostS: number;
  /** Same cost as a percentage of the no-priority wait. */
  trafficWaitCostPct: number;
}

/**
 * Same traffic, same ambulances, signal priority off and on.
 * Four ambulances per run (two each way) at fixed times, so the two runs differ only in the priority switch.
 */
export function runEmergencyBenchmark(scenario: string, seeds: number[], controllerName: 'adaptive' | 'fixed' | 'fixed-tuned' = 'adaptive'): EmergencyResult {
  const make = (): Controller =>
    controllerName === 'adaptive' ? new AdaptiveController() : controllerName === 'fixed-tuned' ? FixedTimeController.tunedFor(avgDemand(scenario)) : FixedTimeController.equalSplit();
  const dispatches = [
    { t: 900, dir: 'EB' as const },
    { t: 1500, dir: 'WB' as const },
    { t: 2300, dir: 'EB' as const },
    { t: 2900, dir: 'WB' as const },
  ];
  const collect = (priority: boolean) => {
    const trips: { journeyS: number; delayS: number; stops: number; waitedS: number }[] = [];
    const waits: number[] = [];
    for (const seed of seeds) {
      const sim = new Simulation({ seed, scenario, controller: make(), priority, emergencies: dispatches });
      sim.run();
      for (const r of sim.emergencyRuns()) if (r.status === 'done') trips.push({ journeyS: r.journeyS!, delayS: r.delayS!, stops: r.stops, waitedS: r.waitedS });
      waits.push(sim.metrics().avgWaitPerVehicleS);
    }
    return { trips, wait: mean(waits) };
  };
  const off = collect(false);
  const on = collect(true);
  const sum = (t: typeof off.trips) => ({
    journeyS: mean(t.map((x) => x.journeyS)),
    delayS: mean(t.map((x) => x.delayS)),
    stops: mean(t.map((x) => x.stops)),
    waitedS: mean(t.map((x) => x.waitedS)),
  });
  return {
    scenario,
    controller: controllerName,
    seeds,
    trips: off.trips.length,
    without: sum(off.trips),
    with: sum(on.trips),
    trafficWaitCostS: on.wait - off.wait,
    trafficWaitCostPct: ((on.wait - off.wait) / off.wait) * 100,
  };
}

export function emergencyMarkdown(rs: EmergencyResult[]): string {
  const f = (x: number, d = 1) => x.toFixed(d);
  const lines = [
    '| Scenario | Controller | Ambulance journey, no priority | with priority | Stops (no priority -> priority) | Cost to other traffic |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of rs) {
    lines.push(
      `| ${r.scenario} | ${r.controller} | ${f(r.without.journeyS)} s (delay ${f(r.without.delayS)} s) | ${f(r.with.journeyS)} s (delay ${f(r.with.delayS)} s) | ${f(r.without.stops, 2)} -> ${f(r.with.stops, 2)} | ${r.trafficWaitCostS >= 0 ? '+' : ''}${f(r.trafficWaitCostS)} s avg wait (${r.trafficWaitCostPct >= 0 ? '+' : ''}${f(r.trafficWaitCostPct)}%) |`,
    );
  }
  return lines.join('\n');
}

// CLI: npm run emergency -w @greenwave/engine -- --seeds=1..10
if (process.argv[1] && /emergency\.(ts|js)$/.test(process.argv[1])) {
  const arg = process.argv.find((a) => a.startsWith('--seeds='))?.slice(8) ?? '1..10';
  const [lo, hi] = arg.split('..').map(Number);
  const seeds = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const results: EmergencyResult[] = [];
  for (const scenario of Object.keys(SCENARIOS)) for (const c of ['fixed', 'adaptive'] as const) results.push(runEmergencyBenchmark(scenario, seeds, c));
  const md = emergencyMarkdown(results);
  console.log(md);
  mkdirSync('out', { recursive: true });
  writeFileSync('out/emergency.md', md + '\n');
  writeFileSync('out/emergency.json', JSON.stringify(results, null, 2));
}
