// Type-only imports: nothing from the engine is bundled into the browser.
import type { EmergencyResult, EmergencyRun, EmergencyVehicleState, ForkResult, ForkRobustness, LoggedDecision, Metrics, NetworkState } from '@greenwave/engine';

export type { EmergencyResult, EmergencyRun, EmergencyVehicleState, ForkResult, ForkRobustness, LoggedDecision, Metrics, NetworkState };

/** Time Machine response: the fork on one seed plus the same fork repeated over several seeds. */
export type ForkResponse = ForkResult & { robustness: ForkRobustness };
export type { Dir, JunctionState, ApproachView } from '@greenwave/engine';

export type ControllerName = 'adaptive' | 'fixed' | 'fixed-tuned';

export interface LiveStatus {
  scenario: string;
  seed: number;
  controller: ControllerName;
  time: number;
  durationS: number;
  running: boolean;
  metrics?: Metrics;
  /** Signal priority for ambulances. */
  priority?: boolean;
  emergencyRuns?: EmergencyRun[];
}

export interface CompareRow {
  label: string;
  digits: number;
  fixed: number;
  tuned: number;
  adaptive: number;
  vsFixedPct: number;
  vsTunedPct: number;
}

export interface CompareResult {
  scenario: string;
  seeds: number[];
  rows: CompareRow[];
  winsVsFixed: number;
  winsVsTuned: number;
}

export const SCENARIOS = [
  { id: 'normal', label: 'Normal peak hour' },
  { id: 'incident', label: 'Blocked lane (incident)' },
  { id: 'rain', label: 'Heavy rain' },
] as const;

export const CONTROLLERS: { id: ControllerName; label: string; hint: string }[] = [
  { id: 'adaptive', label: 'Adaptive', hint: 'Plan follows measured demand' },
  { id: 'fixed', label: 'Fixed', hint: 'Equal split, 60 s cycle' },
  { id: 'fixed-tuned', label: 'Fixed (tuned)', hint: 'Webster plan for average demand' },
];

/** What the Copilot may propose. Nothing runs until an operator approves it. */
export type CopilotAction =
  | { type: 'set_controller'; controller: ControllerName }
  | { type: 'dispatch_emergency'; direction: 'EB' | 'WB' }
  | { type: 'set_priority'; enabled: boolean };

export interface CopilotProposal {
  id: string;
  action: CopilotAction;
  title: string;
  reason: string;
  evidence?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expiresAt: number;
  decidedBy?: string;
  result?: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  mode?: 'claude' | 'built-in';
  proposal?: CopilotProposal | null;
}
