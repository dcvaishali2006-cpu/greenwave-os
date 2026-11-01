import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ForkError, forkRobustness, forkRun } from '../src/timemachine.js';

const base = { scenario: 'incident', seed: 1, atS: 1200, windowS: 900, history: 'fixed' as const };

test('every branch shares one past: identical state and traffic at the fork', () => {
  const r = forkRun(base);
  assert.equal(r.branches.length, 3);
  const first = r.branches[0].atFork;
  for (const b of r.branches) assert.deepEqual(b.atFork, first);
  assert.ok(first.entered > 0);
  assert.ok(r.branches.every((b) => b.entered === r.branches[0].entered), 'the same cars enter in every branch');
});

test('the unchanged branch is the reference: 0% against itself, and it is marked', () => {
  const r = forkRun(base);
  const unchanged = r.branches.filter((b) => b.unchanged);
  assert.equal(unchanged.length, 1);
  assert.equal(unchanged[0].controller, 'fixed');
  assert.equal(unchanged[0].vsUnchangedPct, 0);
});

test('forking is deterministic', () => {
  assert.deepEqual(forkRun(base), forkRun(base));
});

test('bad inputs are rejected with a clear error', () => {
  assert.throws(() => forkRun({ ...base, scenario: 'volcano' }), ForkError);
  assert.throws(() => forkRun({ ...base, atS: 3590 }), /inside the hour/);
  assert.throws(() => forkRun({ ...base, atS: -5 }), ForkError);
  assert.throws(() => forkRun({ ...base, windowS: 10 }), /at least 60/);
  assert.throws(() => forkRun({ ...base, atS: 10.5 }), ForkError);
});

test('the window is cut at the end of the hour', () => {
  const r = forkRun({ ...base, atS: 3000, windowS: 3000 });
  assert.equal(r.windowS, 600);
});

test('each branch has a queue series and the first decisions with reasons', () => {
  const r = forkRun(base);
  for (const b of r.branches) {
    assert.ok(b.series.length >= 50);
    assert.ok(b.series[0].t >= base.atS);
  }
  const adaptive = r.branches.find((b) => b.controller === 'adaptive')!;
  assert.ok(adaptive.firstDecisions.length > 0);
  assert.match(adaptive.firstDecisions[0].reason, /plan|cycle/i);
});

test('through the incident and its recovery, adaptive beats the unchanged fixed plan on most seeds', () => {
  const r = forkRobustness({ scenario: 'incident', atS: 1200, windowS: 2400, history: 'fixed' }, [1, 2, 3, 4, 5, 6]);
  const adaptive = r.branches.find((b) => b.controller === 'adaptive')!;
  assert.ok(adaptive.meanVsUnchangedPct < -10, `mean ${adaptive.meanVsUnchangedPct.toFixed(1)}%`);
  assert.ok(adaptive.wins >= 5, `wins ${adaptive.wins}/6`);
  assert.equal(r.branches.find((b) => b.unchanged)!.wins, 0);
});
