import { websterPlan, flowRatios, DEFAULT_LIMITS, type Plan, type PlanLimits } from './plan.js';
import {
  DEFAULT_NETWORK,
  DIRS,
  PHASE_NAME,
  type Controller,
  type Decision,
  type Dir,
  type JunctionView,
  type NetworkConfig,
  type Phase,
} from './types.js';

const desiredPhase = (plan: Plan, t: number, offsetS: number): { phase: Phase; pos: number } => {
  const pos = (((t - offsetS) % plan.cycleS) + plan.cycleS) % plan.cycleS;
  return { phase: pos < plan.ewWindowS ? 0 : 1, pos };
};

/** 60 s cycle with equal greens: the common default. */
export const equalSplitPlan = (cfg: NetworkConfig = DEFAULT_NETWORK): Plan => {
  const green = 30 - (cfg.clearanceS + cfg.startupLostS);
  return { cycleS: 60, ewWindowS: 30, ewGreenS: green, nsGreenS: green, yEw: 0, yNs: 0 };
};

/** Offset that lets an eastbound platoon released at J1 arrive at each next junction as its green starts. */
const progressiveOffset = (index: number, linkTravelS: number, cycleS: number) => (index * linkTravelS) % cycleS;

/**
 * Baseline: a fixed-time plan, the same all day.
 * It already has a progressive offset between junctions, so the baseline is coordinated too.
 *
 *   FixedTimeController.equalSplit()          60 s cycle, equal greens: the common default
 *   FixedTimeController.tunedFor(demandMult)  Webster plan for the average demand: what a good engineer would set
 */
export class FixedTimeController implements Controller {
  constructor(
    readonly name: string,
    private readonly plan: Plan,
    private readonly linkTravelS = DEFAULT_NETWORK.linkTravelS,
  ) {}

  static equalSplit(cfg: NetworkConfig = DEFAULT_NETWORK): FixedTimeController {
    return new FixedTimeController('fixed', equalSplitPlan(cfg), cfg.linkTravelS);
  }

  static tunedFor(avgDemandMultiplier: number, cfg: NetworkConfig = DEFAULT_NETWORK): FixedTimeController {
    const demand = {} as Record<Dir, number>;
    const service = {} as Record<Dir, number>;
    for (const d of DIRS) {
      demand[d] = cfg.baseRate[d] * avgDemandMultiplier;
      service[d] = cfg.satPerLane * cfg.lanes[d];
    }
    const { yEw, yNs } = flowRatios(demand, service);
    return new FixedTimeController('fixed-tuned', websterPlan(yEw, yNs, cfg), cfg.linkTravelS);
  }

  decide(v: JunctionView): Decision | null {
    const offset = progressiveOffset(v.index, this.linkTravelS, this.plan.cycleS);
    const { phase, pos } = desiredPhase(this.plan, v.t, offset);
    if (phase === v.phase) return null;
    return {
      phase,
      kind: 'switch',
      reason: `Fixed plan: ${PHASE_NAME[phase]} green starts at second ${Math.round(pos)} of the ${this.plan.cycleS} s cycle (offset ${offset} s). The plan never changes with traffic.`,
      inputs: { cycleS: this.plan.cycleS, offsetS: offset, ewGreenS: this.plan.ewGreenS, nsGreenS: this.plan.nsGreenS },
    };
  }
}

export interface AdaptiveOptions {
  /** How often the shared plan is recomputed from detector data. */
  replanEveryS: number;
  /** Queued vehicles are converted to extra demand by assuming they should clear within this many seconds. */
  queueClearS: number;
  /** A new plan is adopted only if the cycle or the split moved by at least this much (avoids jitter). */
  hysteresisS: number;
  /** A phase is never ended before this many seconds of green (safety). */
  minGreenS: number;
  limits: PlanLimits;
}

export const DEFAULT_ADAPTIVE: AdaptiveOptions = {
  replanEveryS: 120,
  queueClearS: 300,
  hysteresisS: 4,
  minGreenS: 8,
  // Cycle capped at 60 s: long cycles break the corridor coordination (found by experiment on seeds 101-110).
  limits: { ...DEFAULT_LIMITS, maxCycleS: 60 },
};

export interface PlanChange {
  t: number;
  plan: Plan;
  reason: string;
}

/**
 * Coordinated adaptive control (the idea behind SCOOT and SCATS, in a small form).
 *
 * Every replanEveryS seconds the controller reads detector flow and queues from all junctions and recomputes
 *   1. demand per approach = measured flow + queue / queueClearS
 *   2. critical flow ratio per phase (the busiest approach of the phase at the busiest junction)
 *   3. a shared cycle length and green split (Webster)
 * and keeps the progressive offsets, so the corridor stays coordinated while the plan follows the traffic.
 * A phase is never ended before minGreenS, and clearance is enforced by the simulator.
 * Every phase change and every plan change carries a plain-English reason (the Why? button).
 */
export class AdaptiveController implements Controller {
  readonly name = 'adaptive';
  readonly planChanges: PlanChange[] = [];
  private readonly o: AdaptiveOptions;
  private plan: Plan;
  private nextReplanT = 0;
  private latest = new Map<number, JunctionView>();
  private linkTravelS: number;

  constructor(options: Partial<AdaptiveOptions> = {}, private readonly cfg: NetworkConfig = DEFAULT_NETWORK) {
    this.o = { ...DEFAULT_ADAPTIVE, ...options };
    this.linkTravelS = cfg.linkTravelS;
    this.plan = equalSplitPlan(cfg);
  }

  get currentPlan(): Plan {
    return this.plan;
  }

  private replan(t: number): void {
    const demand: Record<Dir, number> = { EB: 0, WB: 0, NB: 0, SB: 0 };
    const service = {} as Record<Dir, number>;
    for (const d of DIRS) service[d] = this.cfg.satPerLane * this.cfg.lanes[d];
    // Critical junction: take the maximum over junctions of each approach's demand.
    for (const view of this.latest.values()) {
      for (const d of DIRS) {
        const a = view.approaches[d];
        demand[d] = Math.max(demand[d], a.flowRate + a.queue / this.o.queueClearS);
      }
    }
    const { yEw, yNs } = flowRatios(demand, service);
    const next = websterPlan(yEw, yNs, this.cfg, this.o.limits);
    const moved = Math.abs(next.cycleS - this.plan.cycleS) >= this.o.hysteresisS || Math.abs(next.ewGreenS - this.plan.ewGreenS) >= this.o.hysteresisS;
    if (moved) {
      this.plan = next;
      this.planChanges.push({
        t,
        plan: next,
        reason: `New plan: ${next.cycleS} s cycle, East-West ${next.ewGreenS} s and North-South ${next.nsGreenS} s of green. Critical demand: arterial ${(Math.max(demand.EB, demand.WB) * 60).toFixed(0)} veh/min per approach (${(yEw * 100).toFixed(0)}% of capacity), cross street ${(Math.max(demand.NB, demand.SB) * 60).toFixed(0)} veh/min (${(yNs * 100).toFixed(0)}% of capacity).`,
      });
    }
  }

  decide(v: JunctionView): Decision | null {
    this.latest.set(v.index, v);
    if (v.index === 0 && v.t >= this.nextReplanT) {
      if (v.t > 0) this.replan(v.t);
      this.nextReplanT = v.t + this.o.replanEveryS;
    }

    const offset = progressiveOffset(v.index, this.linkTravelS, this.plan.cycleS);
    const { phase, pos } = desiredPhase(this.plan, v.t, offset);
    if (phase === v.phase || v.greenElapsed < this.o.minGreenS) return null;

    const arterial = Math.max(v.approaches.EB.queue, v.approaches.WB.queue);
    const cross = Math.max(v.approaches.NB.queue, v.approaches.SB.queue);
    return {
      phase,
      kind: 'switch',
      reason:
        `Coordinated plan: ${PHASE_NAME[phase]} green starts at second ${Math.round(pos)} of the ${this.plan.cycleS} s cycle ` +
        `(${this.plan.ewGreenS} s East-West / ${this.plan.nsGreenS} s North-South, set from measured demand). ` +
        (phase === 0 ? `${v.id}'s ${offset} s offset opens the green as the eastbound platoon from upstream arrives. ` : '') +
        `Queues now: arterial ${arterial}, cross street ${cross}.`,
      inputs: { cycleS: this.plan.cycleS, ewGreenS: this.plan.ewGreenS, nsGreenS: this.plan.nsGreenS, offsetS: offset, queueArterial: arterial, queueCross: cross },
    };
  }
}
