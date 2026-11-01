/** Shared types for the GreenWave OS engine. Move these to packages/shared when the API needs them. */

export type Dir = 'EB' | 'WB' | 'NB' | 'SB'; // direction of travel
export type Phase = 0 | 1; // 0 = East-West green, 1 = North-South green

export const DIRS: readonly Dir[] = ['EB', 'WB', 'NB', 'SB'];
export const GROUPS: Record<Phase, Dir[]> = { 0: ['EB', 'WB'], 1: ['NB', 'SB'] };
export const PHASE_OF: Record<Dir, Phase> = { EB: 0, WB: 0, NB: 1, SB: 1 };
export const PHASE_NAME: Record<Phase, string> = { 0: 'East-West', 1: 'North-South' };
export const other = (p: Phase): Phase => (p === 0 ? 1 : 0);

export interface NetworkConfig {
  junctionCount: number;
  /** Travel time between neighbouring junctions on the arterial, seconds. */
  linkTravelS: number;
  lanes: Record<Dir, number>;
  /** Saturation flow per lane in vehicles per second (0.5 = 1800 veh/h/lane). */
  satPerLane: number;
  /** Seconds at the start of green before vehicles begin to discharge. */
  startupLostS: number;
  /** Amber plus all-red between two greens, seconds. */
  clearanceS: number;
  /** Entry demand per source in vehicles per second when the demand multiplier is 1. */
  baseRate: Record<Dir, number>;
  /** CO2 per second of idling in kg. Approximate: ~1 L/h of petrol idling x 2.3 kg CO2 per L. Configurable. */
  idleKgCo2PerS: number;
  /** Ambulance travel time between neighbouring junctions, seconds (faster than ordinary traffic). */
  emergencyLinkS: number;
  /** Signal priority starts this many seconds before the ambulance reaches a junction. */
  emergencyPreemptS: number;
}

export const DEFAULT_NETWORK: NetworkConfig = {
  junctionCount: 5,
  linkTravelS: 25,
  lanes: { EB: 2, WB: 2, NB: 1, SB: 1 },
  satPerLane: 0.5,
  startupLostS: 2,
  clearanceS: 4,
  baseRate: { EB: 0.3, WB: 0.26, NB: 0.1, SB: 0.1 },
  idleKgCo2PerS: (1.0 / 3600) * 2.3,
  emergencyLinkS: 15,
  emergencyPreemptS: 20,
};

export interface Scenario {
  name: string;
  description: string;
  durationS: number;
  /** Demand multiplier at time t. */
  demand(t: number): number;
  /** Capacity multiplier (1 = normal) for an approach at time t. */
  capacityFactor?(junctionIndex: number, dir: Dir, t: number): number;
}

const peak = (t: number) => 0.7 + 0.65 * Math.sin((Math.PI * t) / 3600) ** 2;

export const SCENARIOS: Record<string, Scenario> = {
  normal: {
    name: 'normal',
    description: 'One hour with a rush-hour peak in the middle',
    durationS: 3600,
    demand: peak,
  },
  incident: {
    name: 'incident',
    description: 'Peak hour plus a blocked lane on the eastbound approach at J3 from 20 to 35 minutes',
    durationS: 3600,
    demand: peak,
    capacityFactor: (j, dir, t) => (j === 2 && dir === 'EB' && t >= 1200 && t < 2100 ? 0.35 : 1),
  },
  rain: {
    name: 'rain',
    description: 'Peak hour with heavy rain: 10% more demand and 15% less capacity everywhere',
    durationS: 3600,
    demand: (t) => peak(t) * 1.1,
    capacityFactor: () => 0.85,
  },
};

/** What a controller can see about one approach. */
export interface ApproachView {
  queue: number;
  /** Vehicles due to arrive within the look-ahead horizon (from upstream). */
  upcoming: number;
  /** Vehicles due to arrive within 4 seconds. */
  soon: number;
  /** Seconds since this approach last had green (0 while it is green). */
  redFor: number;
  /** Nominal discharge rate in vehicles per second (lanes x saturation flow). */
  serviceRate: number;
  /** Measured arrival rate in vehicles per second (smoothed over about 90 s), as a detector would report it. */
  flowRate: number;
}

export interface JunctionView {
  index: number;
  id: string;
  t: number;
  phase: Phase;
  greenElapsed: number;
  approaches: Record<Dir, ApproachView>;
}

export interface Decision {
  phase: Phase;
  kind: 'switch' | 'hold';
  /** Plain-English explanation. This is what the Why? button shows. */
  reason: string;
  /** Log a hold decision (used for platoon protection / green wave). */
  notable?: boolean;
  inputs?: Record<string, number | string>;
}

export interface Controller {
  readonly name: string;
  /** Called once per second for each junction that is currently green. Return null to keep going. */
  decide(view: JunctionView): Decision | null;
}

export interface LoggedDecision {
  t: number;
  junctionId: string;
  controller: string;
  kind: 'switch' | 'hold';
  from: Phase;
  to: Phase;
  greenElapsedS: number;
  reason: string;
  inputs?: Record<string, number | string>;
}

export interface Metrics {
  seconds: number;
  entered: number;
  exited: number;
  stops: number;
  /** Total queue delay divided by vehicles that entered. */
  avgWaitPerVehicleS: number;
  stopsPerVehicle: number;
  avgQueue: number;
  maxQueue: number;
  throughputPerHour: number;
  co2Kg: number;
}

export interface JunctionState {
  id: string;
  phase: Phase;
  mode: 'green' | 'clear';
  greenElapsed: number;
  approaches: Record<Dir, ApproachView>;
}

/** One ambulance trip along the corridor. */
export interface EmergencyRun {
  id: string;
  dir: 'EB' | 'WB';
  startT: number;
  endT: number | null;
  /** Journey time if every signal were green on arrival. */
  freeFlowS: number;
  /** Times it had to stop at a red signal. */
  stops: number;
  /** Seconds spent waiting at red signals. */
  waitedS: number;
  /** Total journey time (null until it has left the corridor). */
  journeyS: number | null;
  /** Journey time minus free-flow time. */
  delayS: number | null;
  /** Was signal priority switched on when it was dispatched. */
  priority: boolean;
  status: 'moving' | 'waiting' | 'done';
}

/** Where a moving ambulance is right now, for the map. */
export interface EmergencyVehicleState {
  id: string;
  dir: 'EB' | 'WB';
  status: 'moving' | 'waiting';
  /** Corridor position: 0 = first junction, 1 = second ... Below 0 or above the last index = approaching or leaving. */
  pos: number;
  nextJunction: string | null;
  etaS: number | null;
}

export interface NetworkState {
  t: number;
  controller: string;
  junctions: JunctionState[];
  emergency: EmergencyVehicleState[];
}
