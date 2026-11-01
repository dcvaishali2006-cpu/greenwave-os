import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AdaptiveController, DEFAULT_ADAPTIVE, FixedTimeController } from '../src/controllers.js';
import { runBenchmark } from '../src/benchmark.js';
import { Simulation } from '../src/sim.js';
import { DEFAULT_NETWORK, DIRS, GROUPS, type Controller } from '../src/types.js';

const both: [string, () => Controller][] = [
  ['fixed', () => FixedTimeController.equalSplit()],
  ['adaptive', () => new AdaptiveController()],
];

for (const [name, make] of both) {
  test(`${name}: signals are always safe (clearance between every pair of greens)`, () => {
    for (const scenario of ['normal', 'incident'] as const) {
      const sim = new Simulation({ seed: 5, scenario, controller: make() });
      const prev = new Map<string, { mode: string; phase: number; clearRun: number }>();
      for (let t = 0; t < 3600; t++) {
        sim.step();
        for (const j of sim.state().junctions) {
          const p = prev.get(j.id);
          if (p) {
            if (p.mode === 'green' && j.mode === 'green') assert.equal(j.phase, p.phase, `${j.id} changed phase with no clearance at t=${t}`);
            // The decision tick is itself the first clearance second, so after-step snapshots show clearanceS - 1 clear states.
            if (p.mode === 'clear' && j.mode === 'green') assert.equal(p.clearRun + 1, DEFAULT_NETWORK.clearanceS, `${j.id} clearance was ${p.clearRun + 1}s at t=${t}`);
          }
          const clearRun = j.mode === 'clear' ? (p?.mode === 'clear' ? p.clearRun + 1 : 1) : 0;
          prev.set(j.id, { mode: j.mode, phase: j.phase, clearRun });
        }
      }
    }
  });

  test(`${name}: same seed gives identical results and decision logs`, () => {
    const a = new Simulation({ seed: 11, scenario: 'incident', controller: make() }).run();
    const b = new Simulation({ seed: 11, scenario: 'incident', controller: make() }).run();
    assert.deepEqual(a.metrics(), b.metrics());
    assert.equal(JSON.stringify(a.decisions), JSON.stringify(b.decisions));
  });

  test(`${name}: every logged decision has a reason`, () => {
    const sim = new Simulation({ seed: 2, controller: make() }).run(900);
    assert.ok(sim.decisions.length > 0);
    for (const d of sim.decisions) assert.ok(d.reason.length > 20, `weak reason: "${d.reason}"`);
  });
}

test('different seeds give different traffic', () => {
  const a = new Simulation({ seed: 1, controller: FixedTimeController.equalSplit() }).run().metrics();
  const b = new Simulation({ seed: 2, controller: FixedTimeController.equalSplit() }).run().metrics();
  assert.notEqual(a.entered, b.entered);
});

test('fair comparison: both controllers see exactly the same entry traffic', () => {
  for (const seed of [1, 2, 3]) {
    const f = new Simulation({ seed, controller: FixedTimeController.equalSplit() }).run().metrics();
    const a = new Simulation({ seed, controller: new AdaptiveController() }).run().metrics();
    assert.equal(f.entered, a.entered);
  }
});

test('adaptive never ends a green before the minimum green', () => {
  const sim = new Simulation({ seed: 4, scenario: 'rain', controller: new AdaptiveController() }).run();
  const switches = sim.decisions.filter((d) => d.kind === 'switch');
  assert.ok(switches.length > 100);
  for (const d of switches) assert.ok(d.greenElapsedS >= DEFAULT_ADAPTIVE.minGreenS, `${d.junctionId} switched after ${d.greenElapsedS}s at t=${d.t}`);
});

test('no approach with waiting vehicles is starved (red never exceeds 90 s)', () => {
  const sim = new Simulation({ seed: 6, scenario: 'normal', controller: new AdaptiveController() });
  let worst = 0;
  for (let t = 0; t < 3600; t++) {
    sim.step();
    for (const j of sim.state().junctions) for (const d of DIRS) if (j.approaches[d].queue > 0) worst = Math.max(worst, j.approaches[d].redFor);
  }
  assert.ok(worst <= 90, `worst red with a queue: ${worst}s`);
});

test('time machine: a fork matches its parent until the fork, then diverges', () => {
  // Fork during the incident: the adaptive plan reacts to it, the fixed plan cannot.
  const mk = () => new Simulation({ seed: 9, scenario: 'incident', controller: FixedTimeController.equalSplit(), recordEvery: 1 });
  const parent = mk();
  const child = mk();
  parent.run(2400);
  child.run(1200);
  child.setController(new AdaptiveController());
  child.run(2400);
  const same = (t: number) => JSON.stringify(parent.snapshots[t].junctions.map((j) => [j.phase, j.mode, j.approaches])) === JSON.stringify(child.snapshots[t].junctions.map((j) => [j.phase, j.mode, j.approaches]));
  assert.ok(same(1199), 'states should match right before the fork');
  assert.ok(!same(2399), 'states should differ after the fork');
});

test('queues and vehicle counts stay consistent (nothing is created or lost)', () => {
  const sim = new Simulation({ seed: 8, controller: new AdaptiveController() }).run();
  const m = sim.metrics();
  const inNetwork = sim.state().junctions.reduce((n, j) => n + DIRS.reduce((k, d) => k + j.approaches[d].queue, 0), 0);
  assert.ok(m.exited <= m.entered);
  assert.ok(m.entered - m.exited >= inNetwork, 'vehicles in queues cannot exceed vehicles inside the network');
});

test('adaptive control beats both fixed plans when reality differs from the plan (incident, rain)', () => {
  const seeds = [21, 22, 23, 24, 25];
  for (const scenario of ['incident', 'rain']) {
    const r = runBenchmark(scenario, seeds);
    const wait = r.rows[0];
    assert.ok(wait.adaptive < wait.fixed, `${scenario}: adaptive ${wait.adaptive.toFixed(1)} vs fixed ${wait.fixed.toFixed(1)}`);
    assert.ok(wait.adaptive < wait.tuned, `${scenario}: adaptive ${wait.adaptive.toFixed(1)} vs tuned ${wait.tuned.toFixed(1)}`);
  }
});

test('in typical traffic adaptive is within 5% of a well-coordinated fixed plan and far better than a plan tuned to the average', () => {
  const r = runBenchmark('normal', [31, 32, 33, 34, 35]);
  const wait = r.rows[0];
  assert.ok(wait.adaptive <= wait.fixed * 1.05, `adaptive ${wait.adaptive.toFixed(1)} vs fixed ${wait.fixed.toFixed(1)}`);
  assert.ok(wait.adaptive < wait.tuned, `adaptive ${wait.adaptive.toFixed(1)} vs tuned ${wait.tuned.toFixed(1)}`);
});

void GROUPS;
