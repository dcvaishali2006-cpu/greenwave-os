import { AdaptiveController, FixedTimeController } from './controllers.js';
import { Simulation } from './sim.js';
import { DEFAULT_NETWORK, DIRS, SCENARIOS, type Controller } from './types.js';

export type BranchName = 'fixed' | 'fixed-tuned' | 'adaptive';
export const BRANCH_NAMES: BranchName[] = ['fixed', 'fixed-tuned', 'adaptive'];

const avgDemand = (scenario: string) => {
  const s = SCENARIOS[scenario];
  let sum = 0;
  for (let t = 0; t < s.durationS; t++) sum += s.demand(t);
  return sum / s.durationS;
};

/** One controller by name. Shared by the live simulator, the benchmark and the Time Machine. */
export function makeController(name: BranchName, scenario: string): Controller {
  if (name === 'adaptive') return new AdaptiveController();
  if (name === 'fixed-tuned') return FixedTimeController.tunedFor(avgDemand(scenario));
  return FixedTimeController.equalSplit();
}

export interface ForkOptions {
  scenario: string;
  seed: number;
  /** The moment to branch from, in simulated seconds from the start of the hour. */
  atS: number;
  /** How long to run each branch after the fork. */
  windowS: number;
  /** What was in charge before the fork. Every branch shares this exact past. */
  history: BranchName;
  branches?: BranchName[];
}

export interface BranchResult {
  controller: BranchName;
  /** True for the branch that keeps the historical controller: "if we had changed nothing". */
  unchanged: boolean;
  /** Queue delay per vehicle that entered during the window, seconds. */
  avgWaitPerVehicleS: number;
  avgQueue: number;
  stopsPerVehicle: number;
  /** Largest queue on any approach, sampled every 5 s. */
  maxQueue: number;
  throughputPerHour: number;
  co2Kg: number;
  entered: number;
  /** Change in average wait against the unchanged branch, percent (negative = better). */
  vsUnchangedPct: number;
  /** The state of the network at the fork, identical in every branch (proof that they share one past). */
  atFork: { entered: number; totalQueue: number };
  /** Total vehicles queued across all approaches, every 15 s of the window. */
  series: { t: number; totalQueue: number }[];
  /** The first signal changes after the fork, with their reasons. */
  firstDecisions: { t: number; junctionId: string; reason: string }[];
}

export interface ForkResult {
  scenario: string;
  seed: number;
  atS: number;
  windowS: number;
  history: BranchName;
  branches: BranchResult[];
  best: BranchName;
}

export class ForkError extends Error {}

/**
 * Time Machine. Run the hour once under `history` up to `atS`, then split into one branch per controller and run each for
 * `windowS` more seconds. Entry traffic depends only on the seed, so the branches see exactly the same cars; the past before the fork is
 * identical because each branch re-runs it with the same controller. Only the decisions after the fork differ.
 */
export function forkRun(opts: ForkOptions): ForkResult {
  const scenario = SCENARIOS[opts.scenario];
  if (!scenario) throw new ForkError(`Unknown scenario ${opts.scenario}.`);
  if (!Number.isInteger(opts.atS) || opts.atS < 0 || opts.atS > scenario.durationS - 60) throw new ForkError('The fork time must be inside the hour, at least 60 s before the end.');
  if (!Number.isInteger(opts.windowS) || opts.windowS < 60) throw new ForkError('The window must be at least 60 s.');
  const endS = Math.min(scenario.durationS, opts.atS + opts.windowS);
  const windowS = endS - opts.atS;
  const approachCount = DEFAULT_NETWORK.junctionCount * DIRS.length;
  const names = opts.branches ?? BRANCH_NAMES;

  const results: BranchResult[] = names.map((name) => {
    const sim = new Simulation({ seed: opts.seed, scenario: opts.scenario, controller: makeController(opts.history, opts.scenario), recordEvery: 5 });
    sim.run(opts.atS);
    const m0 = sim.metrics();
    const decisionsBefore = sim.decisions.length;
    const queueNow = () => sim.state().junctions.reduce((a, j) => a + DIRS.reduce((b, d) => b + j.approaches[d].queue, 0), 0);
    const atFork = { entered: m0.entered, totalQueue: queueNow() };
    if (name !== opts.history) sim.setController(makeController(name, opts.scenario));
    sim.run(endS);
    const m1 = sim.metrics();

    const qs0 = m0.avgWaitPerVehicleS * m0.entered;
    const qs1 = m1.avgWaitPerVehicleS * m1.entered;
    const entered = m1.entered - m0.entered;
    const stops = m1.stopsPerVehicle * m1.entered - m0.stopsPerVehicle * m0.entered;
    const snaps = sim.snapshots.filter((s) => s.t >= opts.atS && s.t < endS);
    const total = (s: (typeof snaps)[number]) => s.junctions.reduce((a, j) => a + DIRS.reduce((b, d) => b + j.approaches[d].queue, 0), 0);
    return {
      controller: name,
      unchanged: name === opts.history,
      avgWaitPerVehicleS: (qs1 - qs0) / Math.max(1, entered),
      avgQueue: (qs1 - qs0) / (windowS * approachCount),
      stopsPerVehicle: stops / Math.max(1, entered),
      maxQueue: Math.max(0, ...snaps.map((s) => Math.max(...s.junctions.flatMap((j) => DIRS.map((d) => j.approaches[d].queue))))),
      throughputPerHour: ((m1.exited - m0.exited) / windowS) * 3600,
      co2Kg: (qs1 - qs0) * DEFAULT_NETWORK.idleKgCo2PerS,
      entered,
      vsUnchangedPct: 0,
      atFork,
      series: snaps.filter((s) => (s.t - opts.atS) % 15 === 0).map((s) => ({ t: s.t, totalQueue: total(s) })),
      firstDecisions: sim.decisions
        .slice(decisionsBefore)
        .filter((d) => d.kind === 'switch')
        .slice(0, 3)
        .map((d) => ({ t: d.t, junctionId: d.junctionId, reason: d.reason })),
    };
  });

  const base = results.find((r) => r.unchanged) ?? results[0];
  for (const r of results) r.vsUnchangedPct = ((r.avgWaitPerVehicleS - base.avgWaitPerVehicleS) / Math.max(1e-9, base.avgWaitPerVehicleS)) * 100;
  const best = results.reduce((a, b) => (b.avgWaitPerVehicleS < a.avgWaitPerVehicleS ? b : a)).controller;
  return { scenario: opts.scenario, seed: opts.seed, atS: opts.atS, windowS, history: opts.history, branches: results, best };
}

export interface ForkRobustness {
  seeds: number[];
  branches: {
    controller: BranchName;
    unchanged: boolean;
    meanAvgWaitS: number;
    meanVsUnchangedPct: number;
    /** Seeds in which this branch waited less than the unchanged one (0 for the unchanged branch itself). */
    wins: number;
  }[];
}

/** The same fork over several seeds, so one lucky or unlucky run does not decide the story. */
export function forkRobustness(opts: Omit<ForkOptions, 'seed'>, seeds: number[]): ForkRobustness {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const runs = seeds.map((seed) => forkRun({ ...opts, seed }));
  return {
    seeds,
    branches: runs[0].branches.map((first) => {
      const rows = runs.map((r) => ({ b: r.branches.find((x) => x.controller === first.controller)!, base: r.branches.find((x) => x.unchanged)! }));
      return {
        controller: first.controller,
        unchanged: first.unchanged,
        meanAvgWaitS: mean(rows.map((r) => r.b.avgWaitPerVehicleS)),
        meanVsUnchangedPct: mean(rows.map((r) => r.b.vsUnchangedPct)),
        wins: first.unchanged ? 0 : rows.filter((r) => r.b.avgWaitPerVehicleS < r.base.avgWaitPerVehicleS).length,
      };
    }),
  };
}
