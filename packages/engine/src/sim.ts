import { streamFor, type Rng } from './rng.js';
import {
  DEFAULT_NETWORK,
  DIRS,
  GROUPS,
  PHASE_OF,
  SCENARIOS,
  type ApproachView,
  type Controller,
  type Dir,
  type JunctionView,
  type LoggedDecision,
  type Metrics,
  type NetworkConfig,
  type NetworkState,
  type Phase,
  type Scenario,
} from './types.js';

const LOOKAHEAD_S = 10;
const SOON_S = 4;
const MAX_LOGGED = 20000;

interface ApproachState {
  queue: number;
  credit: number;
  /** Arrival ticks of vehicles on their way here from the upstream junction (ascending). */
  inflight: number[];
  /** Vehicles that arrived in the current second, and the smoothed arrival rate. */
  arrivedNow: number;
  rate: number;
}

interface Junction {
  idx: number;
  id: string;
  phase: Phase;
  mode: 'green' | 'clear';
  greenElapsed: number;
  clearLeft: number;
  nextPhase: Phase;
  lastGreenEnd: [number, number];
  lastNotableAt: number;
  approaches: Record<Dir, ApproachState>;
}

export interface SimOptions {
  seed: number;
  scenario?: Scenario | keyof typeof SCENARIOS;
  controller: Controller;
  network?: Partial<NetworkConfig>;
  /** Keep a snapshot of the whole network every N seconds (0 = off). Used for replay and charts. */
  recordEvery?: number;
}

/**
 * Deterministic traffic simulator for a corridor of signalised junctions.
 *
 * - Arterial (EB / WB) runs through every junction; vehicles leaving one junction reach the next after linkTravelS.
 * - Cross streets (NB / SB) enter at every junction and leave the network after crossing.
 * - Entry arrivals use one independent random stream per source, so two runs with the same seed
 *   see exactly the same external traffic whatever the controller does (fair comparison).
 */
export class Simulation {
  readonly cfg: NetworkConfig;
  readonly scenario: Scenario;
  readonly seed: number;
  readonly decisions: LoggedDecision[] = [];
  readonly snapshots: NetworkState[] = [];

  private controller: Controller;
  private readonly js: Junction[];
  private readonly sources: { j: number; dir: Dir; rng: Rng }[] = [];
  private readonly recordEvery: number;
  private t = 0;

  private entered = 0;
  private exited = 0;
  private stops = 0;
  private queueSeconds = 0;
  private maxQueue = 0;

  constructor(opts: SimOptions) {
    this.cfg = { ...DEFAULT_NETWORK, ...opts.network };
    this.scenario = typeof opts.scenario === 'object' ? opts.scenario : SCENARIOS[opts.scenario ?? 'normal'];
    this.seed = opts.seed;
    this.controller = opts.controller;
    this.recordEvery = opts.recordEvery ?? 0;

    const n = this.cfg.junctionCount;
    this.js = Array.from({ length: n }, (_, idx) => ({
      idx,
      id: `J${idx + 1}`,
      phase: 0 as Phase,
      mode: 'green' as const,
      greenElapsed: 0,
      clearLeft: 0,
      nextPhase: 0 as Phase,
      lastGreenEnd: [0, 0] as [number, number],
      lastNotableAt: -1000,
      approaches: {
        EB: { queue: 0, credit: 0, inflight: [], arrivedNow: 0, rate: 0 },
        WB: { queue: 0, credit: 0, inflight: [], arrivedNow: 0, rate: 0 },
        NB: { queue: 0, credit: 0, inflight: [], arrivedNow: 0, rate: 0 },
        SB: { queue: 0, credit: 0, inflight: [], arrivedNow: 0, rate: 0 },
      },
    }));

    for (let j = 0; j < n; j++) {
      if (j === 0) this.addSource(j, 'EB');
      if (j === n - 1) this.addSource(j, 'WB');
      this.addSource(j, 'NB');
      this.addSource(j, 'SB');
    }
  }

  private addSource(j: number, dir: Dir) {
    this.sources.push({ j, dir, rng: streamFor(this.seed, `${j}/${dir}`) });
  }

  get time(): number {
    return this.t;
  }

  /** Swap the controller mid-run. Used for the Time Machine fork. */
  setController(c: Controller): void {
    this.controller = c;
  }

  private capFactor(j: number, dir: Dir, t: number): number {
    return this.scenario.capacityFactor ? this.scenario.capacityFactor(j, dir, t) : 1;
  }

  private depart(j: number, dir: Dir, t: number): void {
    const n = this.cfg.junctionCount;
    const due = t + this.cfg.linkTravelS;
    if (dir === 'EB' && j < n - 1) this.js[j + 1].approaches.EB.inflight.push(due);
    else if (dir === 'WB' && j > 0) this.js[j - 1].approaches.WB.inflight.push(due);
    else this.exited++;
  }

  private arrive(j: number, dir: Dir, t: number): void {
    const J = this.js[j];
    const A = J.approaches[dir];
    A.arrivedNow++;
    const flowing =
      J.mode === 'green' &&
      J.phase === PHASE_OF[dir] &&
      J.greenElapsed >= this.cfg.startupLostS &&
      A.queue === 0 &&
      this.capFactor(j, dir, t) >= 1;
    if (flowing) {
      this.depart(j, dir, t); // free flow: no stop, no queue
      return;
    }
    A.queue++;
    this.stops++;
  }

  private view(J: Junction, t: number): JunctionView {
    const approaches = {} as Record<Dir, ApproachView>;
    for (const dir of DIRS) {
      const A = J.approaches[dir];
      let upcoming = 0;
      let soon = 0;
      for (const due of A.inflight) {
        const eta = due - t;
        if (eta <= LOOKAHEAD_S) upcoming++;
        if (eta <= SOON_S) soon++;
      }
      const p = PHASE_OF[dir];
      const green = J.mode === 'green' && J.phase === p;
      approaches[dir] = {
        queue: A.queue,
        upcoming,
        soon,
        redFor: green ? 0 : t - J.lastGreenEnd[p],
        serviceRate: this.cfg.satPerLane * this.cfg.lanes[dir],
        flowRate: A.rate,
      };
    }
    return { index: J.idx, id: J.id, t, phase: J.phase, greenElapsed: J.greenElapsed, approaches };
  }

  private log(J: Junction, kind: 'switch' | 'hold', to: Phase, reason: string, inputs?: Record<string, number | string>) {
    if (this.decisions.length >= MAX_LOGGED) return;
    this.decisions.push({
      t: this.t,
      junctionId: J.id,
      controller: this.controller.name,
      kind,
      from: J.phase,
      to,
      greenElapsedS: J.greenElapsed,
      reason,
      inputs,
    });
  }

  /** Advance one second. */
  step(): void {
    const t = this.t;
    const cfg = this.cfg;
    const mult = this.scenario.demand(t);

    // 1. Entry arrivals. Every source draws exactly once per second, whatever happens in the network.
    for (const s of this.sources) {
      const p = Math.min(0.95, cfg.baseRate[s.dir] * mult);
      if (s.rng() < p) {
        this.entered++;
        this.arrive(s.j, s.dir, t);
      }
    }

    // 2. Vehicles arriving from the upstream junction.
    for (const J of this.js) {
      for (const dir of ['EB', 'WB'] as const) {
        const f = J.approaches[dir].inflight;
        while (f.length > 0 && f[0] <= t) {
          f.shift();
          this.arrive(J.idx, dir, t);
        }
      }
    }

    // 2b. Detector flow estimate: exponential smoothing of arrivals per second.
    for (const J of this.js) {
      for (const dir of DIRS) {
        const A = J.approaches[dir];
        A.rate += (A.arrivedNow - A.rate) / 90;
        A.arrivedNow = 0;
      }
    }

    // 3. Controller decisions (only for junctions that are green).
    for (const J of this.js) {
      if (J.mode !== 'green') continue;
      const d = this.controller.decide(this.view(J, t));
      if (!d) continue;
      if (d.phase !== J.phase) {
        this.log(J, 'switch', d.phase, d.reason, d.inputs);
        J.lastGreenEnd[J.phase] = t;
        J.mode = 'clear';
        J.clearLeft = cfg.clearanceS;
        J.nextPhase = d.phase;
      } else if (d.notable && t - J.lastNotableAt >= 10) {
        J.lastNotableAt = t;
        this.log(J, 'hold', J.phase, d.reason, d.inputs);
      }
    }

    // 4. Discharge on green.
    for (const J of this.js) {
      const discharging = J.mode === 'green' && J.greenElapsed >= cfg.startupLostS;
      for (const dir of DIRS) {
        const A = J.approaches[dir];
        if (discharging && PHASE_OF[dir] === J.phase) {
          A.credit += cfg.satPerLane * cfg.lanes[dir] * this.capFactor(J.idx, dir, t);
          while (A.credit >= 1 && A.queue > 0) {
            A.queue--;
            A.credit -= 1;
            this.depart(J.idx, dir, t);
          }
          if (A.queue === 0) A.credit = Math.min(A.credit, 1);
        } else {
          A.credit = 0;
        }
      }
    }

    // 5. Metrics.
    for (const J of this.js) {
      for (const dir of DIRS) {
        const q = J.approaches[dir].queue;
        this.queueSeconds += q;
        if (q > this.maxQueue) this.maxQueue = q;
      }
    }
    if (this.recordEvery > 0 && t % this.recordEvery === 0) this.snapshots.push(this.state());

    // 6. Advance signal timers.
    for (const J of this.js) {
      if (J.mode === 'green') {
        J.greenElapsed++;
      } else {
        J.clearLeft--;
        if (J.clearLeft <= 0) {
          J.phase = J.nextPhase;
          J.mode = 'green';
          J.greenElapsed = 0;
        }
      }
    }

    this.t++;
  }

  run(untilS: number = this.scenario.durationS): this {
    while (this.t < untilS) this.step();
    return this;
  }

  metrics(): Metrics {
    const seconds = Math.max(1, this.t);
    const approachCount = this.cfg.junctionCount * DIRS.length;
    return {
      seconds,
      entered: this.entered,
      exited: this.exited,
      stops: this.stops,
      avgWaitPerVehicleS: this.queueSeconds / Math.max(1, this.entered),
      stopsPerVehicle: this.stops / Math.max(1, this.entered),
      avgQueue: this.queueSeconds / (seconds * approachCount),
      maxQueue: this.maxQueue,
      throughputPerHour: (this.exited / seconds) * 3600,
      co2Kg: this.queueSeconds * this.cfg.idleKgCo2PerS,
    };
  }

  /** The payload the API will push to the dashboard every second. */
  state(): NetworkState {
    return {
      t: this.t,
      controller: this.controller.name,
      junctions: this.js.map((J) => ({
        id: J.id,
        phase: J.phase,
        mode: J.mode,
        greenElapsed: J.greenElapsed,
        approaches: this.view(J, this.t).approaches,
      })),
    };
  }
}

export { GROUPS };
