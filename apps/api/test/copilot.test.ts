import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { AdaptiveController, FixedTimeController, runBenchmark, Simulation } from '@greenwave/engine';
import { createApp } from '../src/app.js';
import { answerBuiltIn, ProposalStore, type CopilotContext } from '../src/copilot.js';
import type { ControllerName } from '../src/liveSim.js';

const cmp = (s: string) => runBenchmark(s, [1, 2, 3]);
const ctxFor = (scenario: string, atS: number, controller: ControllerName, priority = true): CopilotContext => {
  const sim = new Simulation({ seed: 1, scenario, controller: controller === 'adaptive' ? new AdaptiveController() : FixedTimeController.equalSplit() });
  sim.run(atS);
  return { state: sim.state(), time: sim.time, scenario, controller, priority, metrics: sim.metrics(), decisions: (id, n) => sim.decisions.filter((d) => d.junctionId === id).slice(-n), compare: cmp };
};

// ---- the built-in assistant ----

test('summary quotes the real numbers from the live state', () => {
  const ctx = ctxFor('normal', 900, 'fixed');
  const r = answerBuiltIn('How is traffic?', ctx);
  assert.match(r.answer, /15:00/);
  assert.ok(r.answer.includes(ctx.metrics.avgWaitPerVehicleS.toFixed(1)));
  assert.equal(r.proposal, undefined);
});

test('"Why is J3 backing up?" during the blocked lane names the blocked approach and its cause', () => {
  const ctx = ctxFor('incident', 1500, 'fixed');
  const r = answerBuiltIn('Why is J3 backing up?', ctx);
  assert.match(r.answer, /^J3:/);
  assert.match(r.answer, /eastbound approach at J3 is partly blocked/);
  assert.match(r.answer, /35%/);
  assert.equal(r.proposal, undefined);
});

test('during an incident under a fixed plan it proposes Adaptive, with the measured evidence', () => {
  const r = answerBuiltIn('What should I do?', ctxFor('incident', 1500, 'fixed'));
  assert.deepEqual(r.proposal?.action, { type: 'set_controller', controller: 'adaptive' });
  assert.match(r.proposal!.evidence!, /seeded runs.*less than Fixed.*better in \d of 3/);
});

test('when Adaptive is already running it proposes nothing', () => {
  const r = answerBuiltIn('What should I do?', ctxFor('incident', 1500, 'adaptive'));
  assert.equal(r.proposal, undefined);
  assert.match(r.answer, /already in charge/);
});

test('in normal traffic it does not claim Adaptive helps: no proposal', () => {
  const r = answerBuiltIn('What should I do?', ctxFor('normal', 900, 'fixed'));
  assert.equal(r.proposal, undefined);
  assert.match(r.answer, /would not change anything/);
});

test('ambulance requests parse the direction and warn when priority is off', () => {
  const east = answerBuiltIn('Send an ambulance from J1 to J5', ctxFor('normal', 100, 'fixed'));
  assert.deepEqual(east.proposal?.action, { type: 'dispatch_emergency', direction: 'EB' });
  const west = answerBuiltIn('send an ambulance J5 to J1 please', ctxFor('normal', 100, 'fixed'));
  assert.deepEqual(west.proposal?.action, { type: 'dispatch_emergency', direction: 'WB' });
  const off = answerBuiltIn('dispatch an ambulance', ctxFor('normal', 100, 'fixed', false));
  assert.match(off.answer, /priority is OFF/);
});

test('controller and priority requests become proposals; asking for what is already true does not', () => {
  const ctx = ctxFor('normal', 100, 'fixed');
  assert.deepEqual(answerBuiltIn('switch to adaptive', ctx).proposal?.action, { type: 'set_controller', controller: 'adaptive' });
  assert.deepEqual(answerBuiltIn('use the tuned plan', ctx).proposal?.action, { type: 'set_controller', controller: 'fixed-tuned' });
  assert.equal(answerBuiltIn('switch to fixed', ctx).proposal, undefined);
  assert.deepEqual(answerBuiltIn('turn priority off', ctx).proposal?.action, { type: 'set_priority', enabled: false });
  assert.equal(answerBuiltIn('turn priority on', ctx).proposal, undefined);
});

test('unknown questions get the help text, and unknown junctions are named as such', () => {
  assert.match(answerBuiltIn('what is the meaning of life', ctxFor('normal', 100, 'fixed')).answer, /I did not understand/);
  assert.match(answerBuiltIn('why is J9 stuck', ctxFor('normal', 100, 'fixed')).answer, /did not understand|no junction/i);
});

// ---- proposals ----

test('proposals expire, and cannot be decided twice', () => {
  let now = 1000;
  const store = new ProposalStore(60_000, () => now);
  const draft = { action: { type: 'set_priority' as const, enabled: false }, title: 't', reason: 'r' };
  const a = store.create(draft, 'x@demo.com');
  assert.equal(store.decide(a.id, 'approved', 'op@demo.com').status, 'approved');
  assert.throws(() => store.decide(a.id, 'rejected', 'op@demo.com'), /already approved/);
  const b = store.create(draft, 'x@demo.com');
  now += 61_000;
  assert.equal(store.get(b.id)?.status, 'expired');
  assert.throws(() => store.decide(b.id, 'approved', 'op@demo.com'), /expired/);
  assert.throws(() => store.decide('P999', 'approved', 'op@demo.com'), /No proposal/);
});

// ---- the endpoints ----

const claudeReply = (text: string): typeof fetch => (async () => new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 })) as typeof fetch;
let fakeFetch: typeof fetch = claudeReply('');
const ctx = createApp({ port: 0, tickMs: 1000, loginLimitPerMin: 1000, controller: 'fixed', scenario: 'incident', anthropicKey: 'test-key', copilotFetch: ((...a: Parameters<typeof fetch>) => fakeFetch(...a)) as typeof fetch, proposalTtlMs: 60_000 });
let base = '';
before(async () => {
  base = `http://127.0.0.1:${await ctx.start()}/api/v1`;
});
after(() => ctx.close());

const call = async (path: string, opts: { method?: string; token?: string; body?: unknown } = {}) => {
  const res = await fetch(base + path, { method: opts.method ?? 'GET', headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, body: (await res.json()) as any };
};
const tokenOf = async (role: string) => (await call('/auth/login', { method: 'POST', body: { email: `${role}@demo.com`, password: 'demo1234' } })).body.accessToken as string;
const ask = (token: string, message: string) => call('/copilot/ask', { method: 'POST', token, body: { message } });

test('asking needs sign-in and a sensible message', async () => {
  assert.equal((await call('/copilot/ask', { method: 'POST', body: { message: 'hi' } })).status, 401);
  const v = await tokenOf('viewer');
  assert.equal((await ask(v, '   ')).status, 400);
  assert.equal((await ask(v, 'x'.repeat(501))).status, 400);
});

test('Claude mode: a valid JSON reply is used and its proposal becomes a pending proposal', async () => {
  const v = await tokenOf('viewer');
  fakeFetch = claudeReply('```json\n{"answer":"J3 is blocked on the eastbound side.","proposal":{"action":{"type":"set_controller","controller":"adaptive"},"title":"Switch to Adaptive","reason":"Queue is growing."}}\n```');
  const r = await ask(v, 'what is going on?');
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'claude');
  assert.equal(r.body.proposal.status, 'pending');
  assert.equal(r.body.proposal.action.controller, 'adaptive');
});

test('Claude mode: anything unusual falls back to the built-in assistant, and a made-up action is dropped', async () => {
  const v = await tokenOf('viewer');
  for (const bad of ['not json at all', '{"answer":"ok","proposal":{"action":{"type":"delete_everything"},"title":"t","reason":"r"}}', '{"answer":""}']) {
    fakeFetch = claudeReply(bad);
    const r = await ask(v, 'How is traffic?');
    assert.equal(r.body.mode, 'built-in', bad);
    assert.match(r.body.answer, /vehicles have waited/);
  }
  fakeFetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  assert.equal((await ask(v, 'How is traffic?')).body.mode, 'built-in');
  fakeFetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  assert.equal((await ask(v, 'How is traffic?')).body.mode, 'built-in');
});

test('a viewer can ask but cannot approve (403, audited); an operator approves and the action runs once', async () => {
  const v = await tokenOf('viewer');
  const op = await tokenOf('operator');
  fakeFetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  const q = await ask(v, 'switch to adaptive');
  const id = q.body.proposal.id as string;
  assert.equal(ctx.live.cfg.controller, 'fixed', 'asking changes nothing');

  assert.equal((await call(`/copilot/proposals/${id}/approve`, { method: 'POST', token: v })).status, 403);
  assert.equal((await call(`/copilot/proposals/${id}/reject`, { method: 'POST', token: v })).status, 403);
  assert.equal(ctx.live.cfg.controller, 'fixed', 'a refused approval changes nothing');

  const ok = await call(`/copilot/proposals/${id}/approve`, { method: 'POST', token: op });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.proposal.status, 'approved');
  assert.match(ok.body.proposal.result, /Switched from fixed to adaptive/);
  assert.equal(ctx.live.cfg.controller, 'adaptive');

  const again = await call(`/copilot/proposals/${id}/approve`, { method: 'POST', token: op });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_DECIDED');

  const audit = JSON.stringify((await call('/admin/audit?limit=200', { token: await tokenOf('admin') })).body);
  for (const a of ['copilot_ask', 'copilot_approve', 'forbidden', 'switch_controller']) assert.ok(audit.includes(a), a);
});

test('rejecting leaves everything unchanged; unknown proposals are 404', async () => {
  const op = await tokenOf('operator');
  fakeFetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  ctx.live.setController('fixed');
  const q = await ask(op, 'switch to adaptive');
  const rej = await call(`/copilot/proposals/${q.body.proposal.id}/reject`, { method: 'POST', token: op });
  assert.equal(rej.body.proposal.status, 'rejected');
  assert.equal(ctx.live.cfg.controller, 'fixed');
  assert.equal((await call('/copilot/proposals/P99999/approve', { method: 'POST', token: op })).status, 404);
});

test('approving an ambulance dispatch sends it; approving a no-op is refused with 409', async () => {
  const op = await tokenOf('operator');
  fakeFetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  const q = await ask(op, 'send an ambulance from J1 to J5');
  const ok = await call(`/copilot/proposals/${q.body.proposal.id}/approve`, { method: 'POST', token: op });
  assert.match(ok.body.proposal.result, /Ambulance A\d+ dispatched J1 to J5/);
  assert.ok(ctx.live.status().emergencyRuns.length >= 1);

  ctx.live.setController('adaptive');
  const stale = await ask(op, 'switch to fixed');           // proposal made while adaptive is running
  ctx.live.setController('fixed');                          // ...then someone switches by hand
  const noop = await call(`/copilot/proposals/${stale.body.proposal.id}/approve`, { method: 'POST', token: op });
  assert.equal(noop.status, 409);
  assert.equal(noop.body.error.code, 'NO_CHANGE');
});

test('copilot status says which mode is on', async () => {
  const r = await call('/copilot/status', { token: await tokenOf('viewer') });
  assert.equal(r.body.mode, 'claude');
});
