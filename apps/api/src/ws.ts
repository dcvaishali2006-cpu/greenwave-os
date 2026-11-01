import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { AuthService } from './auth.js';
import type { LiveSim } from './liveSim.js';

/**
 * WebSocket at /ws?token=<access token>. A bad token is closed with code 4401.
 *
 * Server messages:
 *   {type:'hello', status}      once, on connect
 *   {type:'tick', state}        every simulated second
 *   {type:'decision', decision} each new signal decision, with its reason
 *   {type:'run', ...status}     controller switched, or a scenario started or restarted
 *   {type:'emergency', ...status} an ambulance was dispatched, or priority was switched
 * Client messages: {type:'subscribe', junctionIds:['J1','J3']} limits tick payloads; {type:'ping'}.
 */
export function attachWebSocket(server: Server, live: LiveSim, auth: AuthService) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const subs = new WeakMap<WebSocket, Set<string> | null>();

  wss.on('connection', (socket, req) => {
    const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token') ?? '';
    try {
      auth.verifyAccess(token);
    } catch {
      socket.close(4401, 'invalid token');
      return;
    }
    subs.set(socket, null);
    socket.send(JSON.stringify({ type: 'hello', status: live.status() }));

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
        if (msg.type === 'subscribe' && Array.isArray(msg.junctionIds)) subs.set(socket, new Set(msg.junctionIds.map(String).slice(0, 50)));
      } catch {
        /* ignore malformed client messages */
      }
    });
  });

  const broadcast = (build: (filter: Set<string> | null) => unknown) => {
    for (const c of wss.clients) {
      if (c.readyState !== WebSocket.OPEN || !subs.has(c)) continue;
      c.send(JSON.stringify(build(subs.get(c) ?? null)));
    }
  };

  live.on('tick', (state) =>
    broadcast((f) => ({ type: 'tick', state: f ? { ...state, junctions: state.junctions.filter((j: { id: string }) => f.has(j.id)) } : state })),
  );
  live.on('decision', (decision) => broadcast(() => ({ type: 'decision', decision })));
  live.on('restart', (status) => broadcast(() => ({ type: 'run', ...status })));
  live.on('controller', (status) => broadcast(() => ({ type: 'run', ...status })));
  live.on('emergency', (status) => broadcast(() => ({ type: 'emergency', ...status })));

  return wss;
}
