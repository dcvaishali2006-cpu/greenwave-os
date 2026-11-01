# @greenwave/engine

The traffic simulator and signal controllers behind GreenWave OS. No database, no network: pure TypeScript you can
call from the API, a test, or a benchmark script. The API streams `sim.state()` to the dashboard once a second.

```bash
npm install
npm test            # 14 tests: safety, determinism, fairness, fork, starvation, adaptive vs fixed
npm run benchmark   # adaptive vs fixed on 3 scenarios x 10 seeds -> out/benchmark.md
npm run demo        # watch a run and read the "Why?" reasons
```

## Use it

```ts
import { Simulation, AdaptiveController, FixedTimeController } from '@greenwave/engine';

const sim = new Simulation({ seed: 7, scenario: 'incident', controller: new AdaptiveController(), recordEvery: 10 });
setInterval(() => { sim.step(); ws.broadcast(sim.state()); }, 1000);   // live tick for the dashboard

sim.decisions.at(-1)?.reason;     // the Why? button: plain-English reason for the last signal change
sim.metrics();                    // wait, queue, stops, throughput, CO2

// Time Machine: replay the same seed, then swap the strategy at second 1200 and compare
const fork = new Simulation({ seed: 7, scenario: 'incident', controller: FixedTimeController.equalSplit() });
fork.run(1200); fork.setController(new AdaptiveController()); fork.run(2400);
```

Same seed + same controller = identical run, so a replay is just a re-run, and a fork is a re-run with a controller swap.

## What is in the box

| File | What it does |
| --- | --- |
| `src/sim.ts` | 5-junction corridor simulator. One random stream per traffic source, so every controller sees identical entry traffic |
| `src/controllers.ts` | `FixedTimeController` (equal split, or Webster-tuned) and `AdaptiveController` |
| `src/plan.ts` | Webster's cycle and split formulas |
| `src/types.ts` | Network config, scenarios (`normal`, `incident`, `rain`), shared types |
| `src/benchmark.ts` | Multi-seed comparison with a markdown table |
| `test/engine.test.ts` | Safety, determinism, fairness, fork, starvation and performance tests |

### How the adaptive controller works

Every 120 s it reads the detector flow and queues from all junctions and recomputes one shared plan:
demand per approach = measured flow + queue / 300 s, critical flow ratio per phase, then Webster's cycle length
(capped at 60 s) and a green split proportional to the flow ratios. Progressive offsets keep the eastbound
platoon on green as the cycle changes. A phase never ends before 8 s of green, and the simulator enforces
4 s clearance. Every signal change and every plan change stores a plain-English reason.

## Results (seeds 1 to 10, one simulated hour each)

Settings were tuned on seeds 101 to 110 and these results are on different seeds.
Average wait per vehicle, in seconds (lower is better):

| Scenario | Fixed (equal split) | Fixed (Webster, average demand) | Adaptive | Adaptive vs fixed | vs tuned |
| --- | --- | --- | --- | --- | --- |
| normal | 22.8 | 28.8 | 22.3 | -2.4% (a tie: 5 of 10 seeds) | -22.6% |
| incident | 85.1 | 83.4 | 66.4 | -22.0% (10 of 10 seeds) | -20.4% |
| rain | 72.9 | 80.9 | 66.4 | -9.0% (8 of 10 seeds) | -18.0% |

How to read this honestly:

- **In ordinary traffic a well-coordinated fixed plan is already very good**, because the fixed baseline here gets a
  perfect eastbound green wave. Adaptive ties it. Say so; judges respect it.
- **When reality departs from the plan (blocked lane, rain, a plan tuned to the wrong demand), adaptive wins by 9 to 22%.**
- A plan tuned to the *average* demand is worse than the equal split in normal traffic, because the peak overloads it.
  This is the case for adapting at all.
- Weak spots: the Webster-tuned plan has fewer stops per vehicle (1.01 vs 1.40 in normal traffic), and in the rain
  scenario its maximum queue is lower than adaptive's (60 vs 96 vehicles).

Full tables for every metric: `npm run benchmark`.

## Limits of the model (put these on a slide, they show you understand the problem)

- Two-phase junctions, no turning movements, no pedestrians, no platoon dispersion.
- Vehicles are counts, not objects. "Wait" is queue delay per vehicle entering the network, not door-to-door time.
- Saturation flow 1,800 veh/h per lane. Idling CO2 assumes about 1 L/h of fuel at 2.3 kg CO2 per litre (approximate, configurable).
- Not built yet: emergency corridor, spillback guard, incident diversions, early gap-out of a green. The controller
  interface (`decide(view) -> Decision`) is where they plug in. SUMO can replace the simulator behind the same state shape.
