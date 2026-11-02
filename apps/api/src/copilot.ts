import { SCENARIOS, type Dir, type LoggedDecision, type Metrics, type NetworkState, type runBenchmark } from '@greenwave/engine';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { CONTROLLER_NAMES, type ControllerName } from './liveSim.js';

// ---------------------------------------------------------------------------------------------------------------
// What the Copilot may propose. Nothing here changes the network: a proposal waits for an operator to approve it.
// ---------------------------------------------------------------------------------------------------------------

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_controller'), controller: z.enum(CONTROLLER_NAMES as [ControllerName, ...ControllerName[]]) }),
  z.object({ type: z.literal('dispatch_emergency'), direction: z.enum(['EB', 'WB']) }),
  z.object({ type: z.literal('set_priority'), enabled: z.boolean() }),
]);
export type ProposalAction = z.infer<typeof actionSchema>;

export interface ProposalDraft {
  action: ProposalAction;
  title: string;
  reason: string;
  evidence?: string;
}

export interface Proposal extends ProposalDraft {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  askedBy: string;
  createdAt: number;
  expiresAt: number;
  decidedBy?: string;
  decidedAt?: number;
  result?: string;
}

/** Proposals waiting for a human. They expire, because the traffic they were based on does not stay the same. */
export class ProposalStore {
  private items = new Map<string, Proposal>();
  private seq = 0;

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  create(draft: ProposalDraft, askedBy: string): Proposal {
    const p: Proposal = { ...draft, id: `P${++this.seq}`, status: 'pending', askedBy, createdAt: this.now(), expiresAt: this.now() + this.ttlMs };
    this.items.set(p.id, p);
    if (this.items.size > 200) this.items.delete(this.items.keys().next().value as string);
    return p;
  }

  get(id: string): Proposal | undefined {
    const p = this.items.get(id);
    if (p && p.status === 'pending' && this.now() > p.expiresAt) p.status = 'expired';
    return p;
  }

  /** Mark a pending proposal approved or rejected. Throws if it is unknown, already decided or expired. */
  decide(id: string, status: 'approved' | 'rejected', by: string, result?: string): Proposal {
    const p = this.get(id);
    if (!p) throw new ApiError(404, 'NOT_FOUND', `No proposal ${id}.`);
    if (p.status === 'expired') throw new ApiError(409, 'EXPIRED', 'This proposal expired. Ask the Copilot again for a fresh one.');
    if (p.status !== 'pending') throw new ApiError(409, 'ALREADY_DECIDED', `This proposal was already ${p.status}.`);
    p.status = status;
    p.decidedBy = by;
    p.decidedAt = this.now();
    p.result = result;
    return p;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The built-in assistant: it reads the live numbers and answers in plain words. No internet, no key, no guessing.
// ---------------------------------------------------------------------------------------------------------------

export interface CopilotContext {
  state: NetworkState;
  time: number;
  scenario: string;
  controller: ControllerName;
  priority: boolean;
  metrics: Metrics;
  decisions(junctionId: string, limit: number): LoggedDecision[];
  compare(scenario: string): ReturnType<typeof runBenchmark>;
}

export interface CopilotReply {
  answer: string;
  proposal?: ProposalDraft;
}

const CONTROLLER_LABEL: Record<ControllerName, string> = { fixed: 'Fixed', 'fixed-tuned': 'Fixed (tuned)', adaptive: 'Adaptive' };
const SCENARIO_LABEL: Record<string, string> = { normal: 'normal peak hour', incident: 'blocked-lane incident', rain: 'heavy rain' };
const DIR_NAME: Record<Dir, string> = { EB: 'eastbound', WB: 'westbound', NB: 'northbound', SB: 'southbound' };
const DIRS: Dir[] = ['EB', 'WB', 'NB', 'SB'];

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const total = (j: NetworkState['junctions'][number]) => DIRS.reduce((a, d) => a + j.approaches[d].queue, 0);

/** Approaches whose capacity the scenario is reducing right now (a blocked lane, rain). */
function reducedCapacity(ctx: CopilotContext): { junction: string; dir: Dir; pct: number }[] {
  const f = SCENARIOS[ctx.scenario]?.capacityFactor;
  if (!f) return [];
  const out: { junction: string; dir: Dir; pct: number }[] = [];
  ctx.state.junctions.forEach((j, idx) => {
    for (const d of DIRS) {
      const factor = f(idx, d, ctx.time);
      if (factor < 1) out.push({ junction: j.id, dir: d, pct: Math.round(factor * 100) });
    }
  });
  return out;
}

function describeReduced(r: ReturnType<typeof reducedCapacity>, total: number): string {
  if (r.length === 0) return '';
  if (r.length > 4) return `Capacity is reduced to ${r[0].pct}% of normal on every approach (heavy rain).`;
  return r.map((x) => `The ${DIR_NAME[x.dir]} approach at ${x.junction} is partly blocked (it can pass only ${x.pct}% of normal traffic)`).join('; ') + '.' + (total > 0 ? '' : '');
}

function busiest(ctx: CopilotContext) {
  const j = ctx.state.junctions.reduce((a, b) => (total(b) > total(a) ? b : a));
  const worst = DIRS.reduce((a, d) => (j.approaches[d].queue > j.approaches[a].queue ? d : a), 'EB' as Dir);
  return { j, worst, count: total(j) };
}

function ambulances(ctx: CopilotContext): string {
  const e = ctx.state.emergency ?? [];
  if (e.length === 0) return '';
  return e.map((a) => `Ambulance ${a.id} is ${a.status === 'waiting' ? 'waiting at a red signal' : 'on its way'}${a.nextJunction ? `, next junction ${a.nextJunction}${a.etaS !== null ? ` in about ${Math.round(a.etaS)} s` : ''}` : ''}.`).join(' ');
}

function summary(ctx: CopilotContext): CopilotReply {
  const m = ctx.metrics;
  const b = busiest(ctx);
  const parts = [
    `At ${clock(ctx.time)} (${SCENARIO_LABEL[ctx.scenario] ?? ctx.scenario}, ${CONTROLLER_LABEL[ctx.controller]} control) vehicles have waited ${m.avgWaitPerVehicleS.toFixed(1)} s on average, with ${m.avgQueue.toFixed(1)} vehicles per approach and about ${Math.round(m.throughputPerHour).toLocaleString('en-US')} vehicles per hour getting through.`,
    b.count > 0 ? `Busiest junction: ${b.j.id} with ${b.count} vehicles waiting (most on the ${DIR_NAME[b.worst]} approach: ${b.j.approaches[b.worst].queue}).` : 'No queues anywhere right now.',
    describeReduced(reducedCapacity(ctx), b.count),
    ambulances(ctx),
  ];
  return { answer: parts.filter(Boolean).join(' ') };
}

function explainJunction(ctx: CopilotContext, id: string): CopilotReply {
  const j = ctx.state.junctions.find((x) => x.id === id);
  if (!j) return { answer: `There is no junction ${id}. The corridor has ${ctx.state.junctions.map((x) => x.id).join(', ')}.` };
  const worst = DIRS.reduce((a, d) => (j.approaches[d].queue > j.approaches[a].queue ? d : a), 'EB' as Dir);
  const queues = DIRS.map((d) => `${DIR_NAME[d]} ${j.approaches[d].queue}`).join(', ');
  const phaseName = j.phase === 0 ? 'East-West' : 'North-South';
  const signal = j.mode === 'green' ? `${phaseName} has had green for ${j.greenElapsed} s` : `${phaseName} is clearing (amber, then all red)`;
  const reduced = reducedCapacity(ctx).filter((r) => r.junction === id);
  const wq = j.approaches[worst].queue;
  const cause =
    reduced.length > 0
      ? `Cause: ${describeReduced(reduced, wq)} Vehicles arrive faster than they can leave, so the queue grows until the lane clears.`
      : wq >= 8
        ? `The ${DIR_NAME[worst]} approach holds the most (${wq}). ${j.mode === 'green' && (j.phase === 0) === (worst === 'EB' || worst === 'WB') ? 'It has green now and is discharging.' : 'Its signal is red for it at the moment, so the queue builds until its green.'}`
        : 'Queues here are small; nothing is backing up.';
  const last = ctx.decisions(id, 1)[0];
  return {
    answer: `${id}: waiting now: ${queues}. ${signal}. ${cause}${last ? ` Latest signal decision (${clock(last.t)}, ${last.controller}): ${last.reason}` : ''}`,
  };
}

function advise(ctx: CopilotContext): CopilotReply {
  const reduced = reducedCapacity(ctx);
  const b = busiest(ctx);
  const issue = reduced.length > 0 ? describeReduced(reduced, b.count) : '';
  const cmp = ctx.compare(ctx.scenario);
  const row = cmp.rows.find((r) => r.label.startsWith('Avg wait'));

  if (ctx.controller === 'adaptive') {
    return { answer: `${issue ? issue + ' ' : ''}The Adaptive controller is already in charge, which is the best option measured for this scenario. ${b.count >= 12 ? `${b.j.id} is the busiest junction (${b.count} waiting); watch it.` : 'No change is recommended right now.'}` };
  }
  const vs = ctx.controller === 'fixed' ? row?.vsFixedPct : row?.vsTunedPct;
  const wins = ctx.controller === 'fixed' ? cmp.winsVsFixed : cmp.winsVsTuned;
  const n = cmp.seeds.length;
  if (vs !== undefined && vs <= -5 && wins >= Math.ceil(n * 0.7)) {
    const evidence = `In ${n} seeded runs of the ${SCENARIO_LABEL[ctx.scenario] ?? ctx.scenario} scenario, Adaptive waited ${Math.abs(vs).toFixed(0)}% less than ${CONTROLLER_LABEL[ctx.controller]}, and was better in ${wins} of ${n} runs.`;
    return {
      answer: `${issue ? issue + ' ' : ''}${CONTROLLER_LABEL[ctx.controller]} control cannot react to this. I suggest switching to Adaptive control. ${evidence} Approve below to apply it.`,
      proposal: { action: { type: 'set_controller', controller: 'adaptive' }, title: 'Switch to Adaptive control', reason: issue || 'Adaptive follows the measured demand.', evidence },
    };
  }
  return { answer: `${issue ? issue + ' ' : ''}I would not change anything: in ${n} seeded runs of this scenario Adaptive is not clearly better than ${CONTROLLER_LABEL[ctx.controller]}${vs !== undefined ? ` (${vs >= 0 ? '+' : ''}${vs.toFixed(0)}% waiting, better in ${wins} of ${n})` : ''}. ${b.count >= 12 ? `${b.j.id} has ${b.count} vehicles waiting, so keep an eye on it.` : ''}`.trim() };
}

function ambulanceReply(ctx: CopilotContext, text: string): CopilotReply {
  const west = /j\s?5\s*(to|->|→|-)\s*j\s?1|west/.test(text) && !/j\s?1\s*(to|->|→|-)\s*j\s?5|east/.test(text);
  const direction = west ? 'WB' : 'EB';
  const route = direction === 'EB' ? 'J1 to J5' : 'J5 to J1';
  const note = ctx.priority ? 'Signal priority is on, so the signals ahead of it will turn green in time.' : 'Signal priority is OFF, so it would wait at red signals like everyone else. Turn priority on first if you want it to get through.';
  return {
    answer: `I can send an ambulance from ${route}. ${note} Approve below to dispatch it.`,
    proposal: { action: { type: 'dispatch_emergency', direction }, title: `Send an ambulance ${route}`, reason: note },
  };
}

const HELP =
  'I can answer from the live data and propose actions for you to approve. Try: "How is traffic?", "Why is J3 backing up?", "What should I do?", "Send an ambulance from J1 to J5", "Switch to adaptive", or "Turn priority off". I never change anything myself: every action waits for an operator to approve it.';

/** Understand a question with keywords and answer from the live numbers. */
export function answerBuiltIn(message: string, ctx: CopilotContext): CopilotReply {
  const t = message.toLowerCase();
  const jm = t.match(/\bj\s?([1-5])\b|junction\s*([1-5])/);
  const jid = jm ? `J${jm[1] ?? jm[2]}` : null;

  if (/ambulance|emergency|fire engine/.test(t) && /(send|dispatch|call|need|run|start)/.test(t)) return ambulanceReply(ctx, t);
  if (/priority/.test(t) && /\b(on|enable|turn on|off|disable|turn off)\b/.test(t)) {
    const enabled = !/\b(off|disable|turn off)\b/.test(t);
    if (enabled === ctx.priority) return { answer: `Signal priority for ambulances is already ${ctx.priority ? 'on' : 'off'}.` };
    return {
      answer: `I can turn signal priority for ambulances ${enabled ? 'on' : 'off'}. Approve below to apply it.`,
      proposal: { action: { type: 'set_priority', enabled }, title: `Turn ambulance priority ${enabled ? 'on' : 'off'}`, reason: enabled ? 'Ambulances will get green lights ahead of them.' : 'Ambulances will obey the signals like other traffic.' },
    };
  }
  const sw = t.match(/(switch|change|use|set|go|move)\b.*\b(adaptive|tuned|fixed)/);
  if (sw) {
    const controller: ControllerName = /adaptive/.test(t) ? 'adaptive' : /tuned/.test(t) ? 'fixed-tuned' : 'fixed';
    if (controller === ctx.controller) return { answer: `${CONTROLLER_LABEL[controller]} control is already running.` };
    return {
      answer: `I can switch to ${CONTROLLER_LABEL[controller]} control. The traffic and queues carry over. Approve below to apply it.`,
      proposal: { action: { type: 'set_controller', controller }, title: `Switch to ${CONTROLLER_LABEL[controller]} control`, reason: `You asked for ${CONTROLLER_LABEL[controller]}.` },
    };
  }
  if (jid && /(why|back|queue|congest|stuck|jam|slow|wait|what|how|happen)/.test(t)) return explainJunction(ctx, jid);
  if (/(recommend|should|advice|advise|suggest|incident|block|problem|what do|what can|improve)/.test(t)) return advise(ctx);
  if (jid) return explainJunction(ctx, jid);
  if (/(status|how|summary|overview|traffic|doing|situation|update|now)/.test(t)) return summary(ctx);
  if (/(help|what can you)/.test(t)) return { answer: HELP };
  return { answer: `I did not understand that. ${HELP}` };
}

/** A compact text version of the live data, for the optional Claude mode. */
export function describeContext(ctx: CopilotContext): string {
  const rows = ctx.state.junctions.map((j) => `${j.id}: waiting ${DIRS.map((d) => `${d} ${j.approaches[d].queue}`).join(', ')}; ${j.mode === 'green' ? (j.phase === 0 ? 'East-West green' : 'North-South green') : 'clearing'}`);
  return [
    `Time ${clock(ctx.time)}. Scenario: ${ctx.scenario}. Controller: ${ctx.controller}. Ambulance priority: ${ctx.priority ? 'on' : 'off'}.`,
    `Average wait ${ctx.metrics.avgWaitPerVehicleS.toFixed(1)} s per vehicle, average queue ${ctx.metrics.avgQueue.toFixed(2)}, throughput ${Math.round(ctx.metrics.throughputPerHour)} veh/h.`,
    ...rows,
    describeReduced(reducedCapacity(ctx), 0),
    ambulances(ctx),
  ]
    .filter(Boolean)
    .join('\n');
}
