import type { Dir, NetworkConfig } from './types.js';

/** A two-phase signal plan shared by every junction on the corridor (needed for coordination). */
export interface Plan {
  cycleS: number;
  /** Seconds from cycle start until the East-West window ends (includes its clearance and start-up). */
  ewWindowS: number;
  /** Effective green seconds for each phase. */
  ewGreenS: number;
  nsGreenS: number;
  /** Critical flow ratios (demand / capacity) that the plan was built from. */
  yEw: number;
  yNs: number;
}

export interface PlanLimits {
  minCycleS: number;
  maxCycleS: number;
  minGreenS: number;
  /** Cap on total flow ratio so the formula stays finite when demand exceeds capacity. */
  maxY: number;
}

export const DEFAULT_LIMITS: PlanLimits = { minCycleS: 40, maxCycleS: 100, minGreenS: 10, maxY: 0.92 };

/**
 * Webster's method: C = (1.5 L + 5) / (1 - Y), greens proportional to the critical flow ratios.
 *   L = lost time per cycle (clearance + start-up, two phases)
 *   Y = sum of the critical flow ratios of the two phases
 */
export function websterPlan(yEw: number, yNs: number, cfg: Pick<NetworkConfig, 'clearanceS' | 'startupLostS'>, lim: PlanLimits = DEFAULT_LIMITS): Plan {
  const lostPerPhase = cfg.clearanceS + cfg.startupLostS;
  const L = 2 * lostPerPhase;
  const Y = Math.min(lim.maxY, Math.max(0.05, yEw + yNs));
  const raw = (1.5 * L + 5) / (1 - Y);
  const cycleS = Math.round(Math.min(lim.maxCycleS, Math.max(lim.minCycleS, raw)) / 5) * 5;
  const G = cycleS - L;
  const share = yEw / Math.max(1e-6, yEw + yNs);
  const ewGreenS = Math.round(Math.min(G - lim.minGreenS, Math.max(lim.minGreenS, G * share)));
  const nsGreenS = G - ewGreenS;
  return { cycleS, ewWindowS: ewGreenS + lostPerPhase, ewGreenS, nsGreenS, yEw, yNs };
}

/** Critical flow ratios from per-approach demand (veh/s) and service rates (veh/s). */
export function flowRatios(demand: Record<Dir, number>, service: Record<Dir, number>) {
  const r = (d: Dir) => demand[d] / service[d];
  return { yEw: Math.max(r('EB'), r('WB')), yNs: Math.max(r('NB'), r('SB')) };
}
