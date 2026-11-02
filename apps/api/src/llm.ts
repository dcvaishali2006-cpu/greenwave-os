import { z } from 'zod';
import { actionSchema, type CopilotReply } from './copilot.js';

const replySchema = z.object({
  answer: z.string().min(1).max(1500),
  proposal: z
    .object({ action: actionSchema, title: z.string().min(1).max(120), reason: z.string().min(1).max(400) })
    .nullish(),
});

const SYSTEM = `You are the Traffic Copilot inside GreenWave OS, a control room for five signalised junctions (J1 to J5) on one road.
Answer ONLY from the DATA block. Never invent numbers, junctions or events. If the data cannot answer, say so.
Be short and plain: two to four sentences, no markdown.
You can propose at most one action, and only these:
  {"type":"set_controller","controller":"fixed"|"fixed-tuned"|"adaptive"}
  {"type":"dispatch_emergency","direction":"EB"|"WB"}   (EB = J1 to J5, WB = J5 to J1)
  {"type":"set_priority","enabled":true|false}
A proposal is only a suggestion: a human operator must approve it. Propose only when the person asks for an action or the data clearly supports one.
Reply with ONLY this JSON and nothing else: {"answer": string, "proposal": null | {"action": {...}, "title": string, "reason": string}}`;

export interface LlmOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Ask Claude. Returns null on any problem (no network, bad status, text that is not the expected JSON,
 * an action that is not on the allowed list), and the caller falls back to the built-in assistant.
 * The model can only propose. It cannot run anything: a proposal still needs an operator's approval.
 */
export async function askClaude(message: string, data: string, o: LlmOptions): Promise<CopilotReply | null> {
  const f = o.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 15_000);
  try {
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: o.model,
        max_tokens: 600,
        system: `${SYSTEM}\n\nDATA\n${data}`,
        messages: [{ role: 'user', content: message }],
      }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((c) => c.type === 'text')?.text ?? '';
    const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = replySchema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    const { answer, proposal } = parsed.data;
    return { answer, proposal: proposal ? { action: proposal.action, title: proposal.title, reason: proposal.reason } : undefined };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
