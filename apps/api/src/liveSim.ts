import { EventEmitter } from 'node:events';
import {
  AdaptiveController,
  FixedTimeController,
  SCENARIOS,
  Simulation,
  type Controller,
  type LoggedDecision,
  type NetworkState,
} from '@greenwave/engine';

export type ControllerName = 'fixed' | 'fixed-tuned' | 'adaptive';
export const CONTROLLER_NAMES: ControllerName[] = ['fixed', 'fixed-tuned', 'adaptive'];

export interface LiveConfig {
  scenario: string;
  seed: number;
  controller: ControllerName;
  /** Simulated seconds per real second. */
  speed: number;
  /** Real milliseconds per simulated second; overrides speed (used by tests). */
  tickMs?: number;
}

const avgDemand = (scenario: string) => {
  const s = SCENARIOS[scenario];
  let sum = 0;
  for (let t = 0; t < s.durationS; t++) sum += s.demand(t);
  return sum / s.durationS;
};

function makeController(name: ControllerName, scenario: string): Controller {
  if (name === 'adaptive') return new AdaptiveController();
  if (name === 'fixed-tuned') return FixedTimeController.tunedFor(avgDemand(scenario));
  return FixedTimeController.equalSplit();
}

/**
 * The simulation that runs continuously behind the dashboard.
 * Emits 'tick' (NetworkState) every simulated second and 'decision' for each new logged decision.
 * When the scenario hour ends it starts again, so the demo never runs dry.
 */
export class LiveSim extends EventEmitter {
  private sim!: Simulation;
  private controller!: Controller;
  private timer?: NodeJS.Timeout;
  private emitted = 0;

  constructor(public cfg: LiveConfig) {
    super();
    this.build();
  }

  private build() {
    this.controller = makeController(this.cfg.controller, this.cfg.scenario);
    this.sim = new Simulation({ seed: this.cfg.seed, scenario: this.cfg.scenario, controller: this.controller });
    this.emitted = 0;
  }

  get time() {
    return this.sim.time;
  }

  state(): NetworkState {
    return this.sim.state();
  }

  status() {
    return { ...this.cfg, time: this.sim.time, durationS: this.sim.scenario.durationS, running: !!this.timer };
  }

  metrics() {
    return this.sim.metrics();
  }

  /** Most recent logged decisions, newest first, optionally for one junction. This is the Why? button. */
  decisions(junctionId?: string, limit = 5): LoggedDecision[] {
    const out: LoggedDecision[] = [];
    for (let i = this.sim.decisions.length - 1; i >= 0 && out.length < limit; i--) {
      const d = this.sim.decisions[i];
      if (!junctionId || d.junctionId === junctionId) out.push(d);
    }
    return out;
  }

  planChanges() {
    return this.controller instanceof AdaptiveController ? this.controller.planChanges.slice(-10).reverse() : [];
  }

  /** Advance the simulation by one second and publish it. */
  tick(): void {
    this.sim.step();
    this.emit('tick', this.sim.state());
    for (; this.emitted < this.sim.decisions.length; this.emitted++) this.emit('decision', this.sim.decisions[this.emitted]);
    if (this.sim.time >= this.sim.scenario.durationS) {
      this.build();
      this.emit('restart', this.status());
    }
  }

  start(): void {
    if (this.timer) return;
    const everyMs = this.cfg.tickMs ?? Math.max(20, 1000 / this.cfg.speed);
    this.timer = setInterval(() => this.tick(), everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Swap the strategy mid-run (the simulation keeps its traffic and queues). */
  setController(name: ControllerName): void {
    this.cfg.controller = name;
    this.controller = makeController(name, this.cfg.scenario);
    this.sim.setController(this.controller);
    this.emit('controller', this.status());
  }

  reset(next: Partial<LiveConfig>): void {
    const wasRunning = !!this.timer;
    this.stop();
    this.cfg = { ...this.cfg, ...next };
    this.build();
    this.emit('restart', this.status());
    if (wasRunning) this.start();
  }
}
