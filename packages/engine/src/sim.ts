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
  type EmergencyRun,
  type EmergencyVehicleState,
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
/** An emergency switch may end a green only after this many seconds of it (safety minimum). */
const EMERGENCY_MIN_GREEN_S = 5;
/** Extra seconds an ambulance needs per queued vehicle it weaves past, capped at 12 vehicles. */
const WEAVE_S_PER_VEHICLE = 0.4;
const WEAVE_MAX_QUEUE = 12;

interface EmergencyVehicle {
  run: EmergencyRun;
  order: number[];
  /** Index in `order` of the next junction to clear. */
  k: number;
  /** Time it reaches junction order[k] if nothing holds it up. */
  arriveAt: number;
  /** Set once the signal is green for it: the second it clears the junction. */
  passAt: number | null;
  /** After the last junction: the second it leaves the corridor. */
  exitAt: number | null;
  announced: Set<number>;
}

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
  /** Signal priority for ambulances (default on). Can be switched during a run. */
  priority?: boolean;
  /** Ambulances to dispatch at given seconds. Deterministic, so runs can be compared. */
  emergencies?: { t: number; dir: 'EB' | 'WB' }[];
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

  private priority: boolean;
  private readonly evs: EmergencyVehicle[] = [];
  private scheduled: { t: number; dir: 'EB' | 'WB' }[];

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
    this.priority = opts.priority ?? true;
    this.scheduled = [...(opts.emergencies ?? [])].sort((a, b) => a.t - b.t);

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

  private log(J: Junction, kind: 'switch' | 'hold', to: Phase, reason: string, inputs?: Record<string, number | string>, source?: string) {
    if (this.decisions.length >= MAX_LOGGED) return;
    this.decisions.push({
      t: this.t,
      junctionId: J.id,
      controller: source ?? this.controller.name,
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

    // 2c. Ambulances: move them, and find the junctions that must give them a green.
    const held = this.updateEmergency(t);

    // 3. Controller decisions (only for junctions that are green). Ambulance priority comes first.
    for (const J of this.js) {
      const claim = held.get(J.idx);
      if (claim) {
        this.emergencyHold(J, claim.ev, claim.etaS, t);
        continue;
      }
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

  // ---- Emergency vehicles ----

  /** Priority on/off. Takes effect from the next second. */
  setPriority(on: boolean): void {
    this.priority = on;
  }

  get priorityOn(): boolean {
    return this.priority;
  }

  /** Send an ambulance down the corridor now, eastbound (J1 to the last junction) or westbound. */
  dispatchEmergency(dir: 'EB' | 'WB'): EmergencyRun {
    const n = this.cfg.junctionCount;
    const L = this.cfg.emergencyLinkS;
    const order = dir === 'EB' ? Array.from({ length: n }, (_, i) => i) : Array.from({ length: n }, (_, i) => n - 1 - i);
    const run: EmergencyRun = {
      id: `A${this.evs.length + 1}`,
      dir,
      startT: this.t,
      endT: null,
      freeFlowS: L * (n + 1),
      stops: 0,
      waitedS: 0,
      journeyS: null,
      delayS: null,
      priority: this.priority,
      status: 'moving',
    };
    this.evs.push({ run, order, k: 0, arriveAt: this.t + L, passAt: null, exitAt: null, announced: new Set() });
    return { ...run };
  }

  /** Results of every ambulance trip so far (newest last). */
  emergencyRuns(): EmergencyRun[] {
    return this.evs.map((e) => ({ ...e.run }));
  }

  private updateEmergency(t: number): Map<number, { ev: EmergencyVehicle; etaS: number }> {
    const L = this.cfg.emergencyLinkS;
    while (this.scheduled.length > 0 && this.scheduled[0].t <= t) this.dispatchEmergency(this.scheduled.shift()!.dir);

    const held = new Map<number, { ev: EmergencyVehicle; etaS: number }>();
    for (const ev of this.evs) {
      const r = ev.run;
      if (r.status === 'done') continue;

      if (ev.k >= ev.order.length) {
        if (t >= ev.exitAt!) {
          r.status = 'done';
          r.endT = t;
          r.journeyS = t - r.startT;
          r.delayS = r.journeyS - r.freeFlowS;
        }
        continue;
      }

      const j = ev.order[ev.k];
      const J = this.js[j];
      if (ev.passAt === null && t >= ev.arriveAt) {
        if (J.mode === 'green' && J.phase === 0) {
          const queue = J.approaches[r.dir].queue;
          ev.passAt = t + Math.ceil(Math.min(queue, WEAVE_MAX_QUEUE) * WEAVE_S_PER_VEHICLE);
        } else {
          if (r.status !== 'waiting') {
            r.status = 'waiting';
            r.stops++;
          }
          r.waitedS++;
        }
      }
      if (ev.passAt !== null && t >= ev.passAt) {
        r.status = 'moving';
        ev.k++;
        ev.passAt = null;
        if (ev.k >= ev.order.length) ev.exitAt = t + L;
        else ev.arriveAt = t + L;
        continue;
      }

      if (this.priority) {
        const firstEta = ev.passAt !== null ? 0 : Math.max(0, ev.arriveAt - t);
        for (let m = ev.k; m < ev.order.length; m++) {
          const eta = firstEta + (m - ev.k) * L;
          if (eta > this.cfg.emergencyPreemptS) break;
          if (!held.has(ev.order[m])) held.set(ev.order[m], { ev, etaS: eta });
        }
      }
    }
    return held;
  }

  /** Give the ambulance an East-West green at this junction, within the safety limits (minimum green, clearance). */
  private emergencyHold(J: Junction, ev: EmergencyVehicle, etaS: number, t: number): void {
    const id = ev.run.id;
    const who = `ambulance ${id} (${ev.run.dir === 'EB' ? 'eastbound' : 'westbound'})`;
    const say = (kind: 'switch' | 'hold', reason: string) => {
      if (ev.announced.has(J.idx)) return;
      ev.announced.add(J.idx);
      this.log(J, kind, 0, reason, { ambulance: id, etaS }, 'emergency');
    };

    if (J.mode === 'clear') {
      if (J.nextPhase !== 0) {
        say('switch', `Emergency corridor: ${who} reaches ${J.id} in about ${etaS} s. The coming green is given to East-West instead of North-South.`);
        J.nextPhase = 0;
      }
      return;
    }
    if (J.phase === 0) {
      say('hold', `Emergency corridor: ${who} reaches ${J.id} in about ${etaS} s. East-West green is held so it passes without stopping; the cross street waits.`);
      return;
    }
    if (J.greenElapsed >= EMERGENCY_MIN_GREEN_S) {
      say('switch', `Emergency corridor: ${who} reaches ${J.id} in about ${etaS} s. North-South green ended early, after ${J.greenElapsed} s, so East-West is green when it arrives.`);
      J.lastGreenEnd[J.phase] = t;
      J.mode = 'clear';
      J.clearLeft = this.cfg.clearanceS;
      J.nextPhase = 0;
    }
  }

  private emergencyState(): EmergencyVehicleState[] {
    const L = this.cfg.emergencyLinkS;
    const out: EmergencyVehicleState[] = [];
    for (const ev of this.evs) {
      const r = ev.run;
      if (r.status === 'done') continue;
      const sign = r.dir === 'EB' ? 1 : -1;
      let pos: number;
      let etaS: number | null = null;
      let nextJunction: string | null = null;
      if (ev.k >= ev.order.length) {
        const frac = 1 - Math.max(0, ev.exitAt! - this.t) / L;
        pos = ev.order[ev.order.length - 1] + sign * frac;
      } else {
        const next = ev.order[ev.k];
        const eta = ev.passAt !== null ? 0 : Math.max(0, ev.arriveAt - this.t);
        pos = next - sign * (eta / L);
        etaS = eta;
        nextJunction = this.js[next].id;
      }
      out.push({ id: r.id, dir: r.dir, status: r.status === 'waiting' ? 'waiting' : 'moving', pos, nextJunction, etaS });
    }
    return out;
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
      emergency: this.emergencyState(),
    };
  }
}

export { GROUPS };
