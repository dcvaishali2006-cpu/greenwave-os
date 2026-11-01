'use client';
import { useEffect, useRef, useState } from 'react';
import { API, api, getAccessToken } from './api';
import type { LiveStatus, LoggedDecision, NetworkState } from './types';

export interface FeedItem extends LoggedDecision {
  key: number;
}

/**
 * Live feed: opens the WebSocket, reconnects with backoff, and keeps the latest state,
 * the latest decisions and the run status (polled every 2 s for the KPI numbers).
 */
export function useLive(enabled: boolean) {
  const [state, setState] = useState<NetworkState | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const keyRef = useRef(0);

  const refreshStatus = () => api<LiveStatus>('/live/status').then(setStatus).catch(() => {});

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      const token = getAccessToken();
      if (!token || closed) return;
      ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws?token=${token}`);
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'tick') setState(m.state);
        else if (m.type === 'decision') setFeed((f) => [{ ...m.decision, key: keyRef.current++ }, ...f].slice(0, 40));
        else if (m.type === 'run') {
          setFeed([]);
          refreshStatus();
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
      };
    };

    connect();
    refreshStatus();
    const poll = setInterval(refreshStatus, 2000);
    return () => {
      closed = true;
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [enabled]);

  return { state, status, feed, connected, refreshStatus };
}
