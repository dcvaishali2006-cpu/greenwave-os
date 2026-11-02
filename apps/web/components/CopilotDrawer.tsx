'use client';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { ApiFail, api, type User } from '@/lib/api';
import type { ChatMessage, CopilotProposal } from '@/lib/types';

const CHIPS = ['How is traffic?', 'What should I do?', 'Why is J3 backing up?', 'Send an ambulance from J1 to J5', 'Switch to adaptive'];
const GREETING = 'I am the Traffic Copilot. Ask me about the corridor in plain words. I answer from the live numbers, and when I suggest an action it waits for an operator to approve it. I never change anything myself.';

interface AskResponse {
  answer: string;
  mode: 'claude' | 'built-in';
  proposal: CopilotProposal | null;
}

/** Chat with the Copilot. Proposals show as cards with Approve and Reject; only operators and admins can use them. */
export default function CopilotDrawer({
  user,
  messages,
  setMessages,
  onChanged,
  onClose,
}: {
  user: User;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'claude' | 'built-in' | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const idRef = useRef(messages.length);
  const canApprove = user.role === 'operator' || user.role === 'admin';

  // The page re-renders every second, so keep the close handler in a ref and focus the input only once.
  const closeFn = useRef(onClose);
  closeFn.current = onClose;
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeFn.current();
    window.addEventListener('keydown', onKey);
    api<{ mode: 'claude' | 'built-in' }>('/copilot/status').then((r) => setMode(r.mode)).catch(() => {});
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, busy]);

  const patchProposal = (p: CopilotProposal) => setMessages((ms) => ms.map((m) => (m.proposal?.id === p.id ? { ...m, proposal: p } : m)));

  const send = async (raw: string) => {
    const message = raw.trim();
    if (!message || busy) return;
    setText('');
    setBusy(true);
    setMessages((ms) => [...ms, { id: idRef.current++, role: 'user', text: message }]);
    try {
      const r = await api<AskResponse>('/copilot/ask', { method: 'POST', body: JSON.stringify({ message }) });
      setMode(r.mode);
      setMessages((ms) => [...ms, { id: idRef.current++, role: 'assistant', text: r.answer, mode: r.mode, proposal: r.proposal }]);
    } catch (e) {
      setMessages((ms) => [...ms, { id: idRef.current++, role: 'assistant', text: e instanceof ApiFail ? e.message : 'I could not reach the server. Try again.' }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const decide = async (p: CopilotProposal, what: 'approve' | 'reject') => {
    setErrors((e) => ({ ...e, [p.id]: '' }));
    try {
      const r = await api<{ proposal: CopilotProposal }>(`/copilot/proposals/${p.id}/${what}`, { method: 'POST' });
      patchProposal(r.proposal);
      onChanged();
    } catch (e) {
      setErrors((x) => ({ ...x, [p.id]: e instanceof ApiFail ? e.message : 'That did not work. Try again.' }));
      if (e instanceof ApiFail && /expired/i.test(e.message)) patchProposal({ ...p, status: 'expired' });
    }
  };

  return (
    <aside role="dialog" aria-label="Traffic Copilot" className="fixed inset-y-0 right-0 z-[900] flex w-full flex-col border-l border-line bg-panel shadow-2xl sm:w-[420px]">
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-base font-bold text-text">Traffic Copilot</h2>
          <p className="mt-0.5 text-[11px] text-muted">
            {mode === 'claude' ? 'Powered by Claude, from the live data.' : 'Built-in assistant, from the live data.'} Actions need approval.
          </p>
        </div>
        <button onClick={onClose} aria-label="Close Copilot" className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-text">Close</button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-live="polite">
        <div className="rounded-xl bg-ink px-3 py-2 text-xs leading-relaxed text-muted">{GREETING}</div>
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
            <div className={`max-w-[92%] rounded-xl px-3 py-2 text-xs leading-relaxed ${m.role === 'user' ? 'bg-ai text-white' : 'bg-ink text-text'}`}>
              {m.text}
              {m.proposal && (
                <div className="mt-2 rounded-lg border border-ai/50 bg-panel p-2.5 text-muted">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-text">{m.proposal.title}</span>
                    <span className={`rounded px-1.5 py-px text-[10px] font-semibold uppercase ${m.proposal.status === 'approved' ? 'bg-go/20 text-go' : m.proposal.status === 'pending' ? 'bg-ai/20 text-ai' : 'bg-raised text-muted'}`}>{m.proposal.status}</span>
                  </div>
                  <p className="mt-1">{m.proposal.reason}</p>
                  {m.proposal.evidence && <p className="mt-1 text-[11px]">{m.proposal.evidence}</p>}
                  {m.proposal.result && <p className="mt-1 text-[11px] text-go">{m.proposal.result}</p>}
                  {m.proposal.status === 'pending' && (
                    <div className="mt-2 flex items-center gap-2">
                      <button disabled={!canApprove} onClick={() => decide(m.proposal!, 'approve')} title={canApprove ? 'Run this action' : 'Only operators and admins can approve'} className="rounded-lg bg-go px-3 py-1.5 text-xs font-semibold text-ink transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">Approve</button>
                      <button disabled={!canApprove} onClick={() => decide(m.proposal!, 'reject')} className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-text disabled:cursor-not-allowed disabled:opacity-40">Reject</button>
                      {!canApprove && <span className="text-[11px]">Read-only account: you can ask, an operator approves.</span>}
                    </div>
                  )}
                  {errors[m.proposal.id] && <p role="alert" className="mt-1 text-[11px] text-stop">{errors[m.proposal.id]}</p>}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="h-8 w-24 animate-pulse rounded-xl bg-ink" aria-busy="true" />}
      </div>

      <div className="border-t border-line px-4 py-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {CHIPS.map((c) => (
            <button key={c} disabled={busy} onClick={() => send(c)} className="rounded-full border border-line bg-ink px-2.5 py-1 text-[11px] text-muted transition hover:text-text disabled:opacity-50">{c}</button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
          className="flex items-end gap-2"
        >
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
            rows={2}
            maxLength={500}
            placeholder="Ask about the corridor..."
            aria-label="Ask the Copilot"
            className="min-h-[44px] flex-1 resize-none rounded-lg border border-line bg-ink px-3 py-2 text-xs text-text placeholder:text-muted"
          />
          <button type="submit" disabled={busy || !text.trim()} className="rounded-lg bg-ai px-4 py-2 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50">Send</button>
        </form>
      </div>
    </aside>
  );
}
