import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AdaptiveController, FixedTimeController } from '../src/controllers.js';
import { runEmergencyBenchmark } from '../src/emergency.js';
import { Simulation } from '../src/sim.js';
import { DEFAULT_NETWORK } from '../src/types.js';

const DISPATCH = [
  { t: 900, dir: 'EB' as const },
  { t: 1500, dir: 'WB' as const },
];

for (const [name, make] of [
  ['fixed', () => FixedTimeController.equalSplit()],
  ['adaptive', () => new AdaptiveController()],
] as const) {
  test(`${name}: priority never breaks signal safety (clearance kept, emergency switches never cut a green shorter than 5 s)`, () => {
    const sim = new Simulation({ seed: 3, scenario: 'incident', controller: make(), priority: true, emergencies: DISPATCH });
    const prev = new Map<string, { mode: string; phase: number; clearRun: number }>();
    for (let t = 0; t < 3600; t++) {
      sim.step();
      for (const j of sim.state().junctions) {
        const p = prev.get(j.id);
        if (p) {
          if (p.mode === 'green' && j.mode === 'green') assert.equal(j.phase, p.phase, `${j.id} changed phase with no clearance at t=${t}`);
          if (p.mode === 'clear' && j.mode === 'green') assert.equal(p.clearRun + 1, DEFAULT_NETWORK.clearanceS, `${j.id} clearance was ${p.clearRun + 1}s at t=${t}`);
        }
        prev.set(j.id, { mode: j.mode, phase: j.phase, clearRun: j.mode === 'clear' ? (p?.mode === 'clear' ? p.clearRun + 1 : 1) : 0 });
      }
    }
    for (const d of sim.decisions.filter((x) => x.kind === 'switch' && x.controller === 'emergency')) {
      assert.ok(d.greenElapsedS >= 5, `${d.junctionId} green ended after ${d.greenElapsedS}s at t=${d.t} (${d.controller})`);
    }
  });
}

test('with priority an ambulance never stops and finishes close to free-flow time', () => {
  const sim = new Simulation({ seed: 1, scenario: 'normal', controller: new AdaptiveController(), priority: true, emergencies: DISPATCH });
  sim.run();
  const runs = sim.emergencyRuns();
  assert.equal(runs.length, 2);
  for (const r of runs) {
    assert.equal(r.status, 'done');
    assert.equal(r.stops, 0);
    assert.ok(r.delayS! <= 12, `delay ${r.delayS}s`);
    assert.equal(r.freeFlowS, DEFAULT_NETWORK.emergencyLinkS * (DEFAULT_NETWORK.junctionCount + 1));
  }
});

test('without priority the same ambulances are held up at red signals', () => {
  const on = new Simulation({ seed: 1, scenario: 'normal', controller: FixedTimeController.equalSplit(), priority: true, emergencies: DISPATCH }).run();
  const off = new Simulation({ seed: 1, scenario: 'normal', controller: FixedTimeController.equalSplit(), priority: false, emergencies: DISPATCH }).run();
  const sum = (s: Simulation) => s.emergencyRuns().reduce((a, r) => a + r.journeyS!, 0);
  assert.ok(sum(off) > sum(on) + 60, `off ${sum(off)}s vs on ${sum(on)}s`);
  assert.ok(off.emergencyRuns().some((r) => r.stops > 0));
});

test('priority does not change the outside traffic: same vehicles enter either way', () => {
  const a = new Simulation({ seed: 9, scenario: 'incident', controller: new AdaptiveController(), priority: true, emergencies: DISPATCH }).run();
  const b = new Simulation({ seed: 9, scenario: 'incident', controller: new AdaptiveController(), priority: false, emergencies: DISPATCH }).run();
  assert.equal(a.metrics().entered, b.metrics().entered);
});

test('the same seed and dispatches give identical ambulance results', () => {
  const run = () => new Simulation({ seed: 4, scenario: 'rain', controller: new AdaptiveController(), emergencies: DISPATCH }).run().emergencyRuns();
  assert.deepEqual(run(), run());
});

test('emergency decisions are logged with the ambulance named, and ambulance positions stay in range', () => {
  const sim = new Simulation({ seed: 2, scenario: 'normal', controller: FixedTimeController.equalSplit(), priority: true });
  sim.run(890);
  const run = sim.dispatchEmergency('EB');
  assert.equal(run.id, 'A1');
  let seen = 0;
  let last = -Infinity;
  for (let i = 0; i < 140; i++) {
    sim.step();
    for (const e of sim.state().emergency) {
      seen++;
      assert.ok(e.pos >= -1.01 && e.pos <= DEFAULT_NETWORK.junctionCount + 0.01, `pos ${e.pos}`);
      assert.ok(e.pos >= last - 1e-9, 'eastbound position never goes backwards');
      last = e.pos;
    }
  }
  assert.ok(seen > 50);
  const logged = sim.decisions.filter((d) => d.controller === 'emergency');
  assert.ok(logged.length >= 1);
  assert.match(logged[0].reason, /ambulance A1/);
  assert.equal(sim.state().emergency.length, 0, 'finished ambulances leave the state');
});

test('switching priority off mid-run takes effect', () => {
  const sim = new Simulation({ seed: 1, scenario: 'normal', controller: FixedTimeController.equalSplit() });
  sim.run(890);
  sim.setPriority(false);
  const r = sim.dispatchEmergency('EB');
  assert.equal(r.priority, false);
  sim.run(1200);
  assert.ok(sim.emergencyRuns()[0].stops > 0);
});

test('benchmark: priority saves ambulance time on every scenario', () => {
  for (const scenario of ['normal', 'incident', 'rain']) {
    const r = runEmergencyBenchmark(scenario, [1, 2, 3], 'adaptive');
    assert.ok(r.with.journeyS < r.without.journeyS - 30, `${scenario}: ${r.with.journeyS} vs ${r.without.journeyS}`);
    assert.equal(r.with.stops, 0);
  }
});
