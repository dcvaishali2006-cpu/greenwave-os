import { AdaptiveController } from './controllers.js';
import { Simulation } from './sim.js';
import { PHASE_NAME } from './types.js';

// npm run demo: watch the adaptive controller and read its reasons (this is what the Why? button will show).
const sim = new Simulation({ seed: 7, scenario: 'incident', controller: new AdaptiveController() });
sim.run(1800);

const s = sim.state();
console.log(`t = ${s.t}s, controller = ${s.controller}`);
for (const j of s.junctions) {
  const q = (['EB', 'WB', 'NB', 'SB'] as const).map((d) => `${d}:${String(j.approaches[d].queue).padStart(2)}`).join(' ');
  console.log(`${j.id}  ${PHASE_NAME[j.phase].padEnd(11)} ${j.mode.padEnd(5)} green ${String(j.greenElapsed).padStart(2)}s   queues ${q}`);
}

const j3 = sim.decisions.filter((d) => d.junctionId === 'J3');
console.log(`\nJ3 made ${j3.length} logged decisions. Last 6:`);
for (const d of j3.slice(-6)) console.log(`  t=${String(d.t).padStart(4)} ${d.kind.padEnd(6)} ${d.reason}`);

const platoon = sim.decisions.find((d) => d.kind === 'hold');
if (platoon) console.log(`\nA green-wave hold, as the Why? button would show it:\n  ${platoon.junctionId} t=${platoon.t}: ${platoon.reason}`);
console.log('\nMetrics so far:', sim.metrics());
