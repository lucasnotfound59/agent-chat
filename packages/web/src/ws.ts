import type { HubEvent } from './types';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface HubSocketOptions {
  token: string;
  onEvent(e: HubEvent): void;
  onStatus(s: WsStatus): void;
  /** Called after each successful auth, including reconnects: the place to re-sync. */
  onReady(): void;
  onUnauthorized(): void;
  url?: string;
  createSocket?: (url: string) => WebSocket;
  schedule?: (fn: () => void, ms: number) => void;
}

/** Keeps one authenticated connection to /ws, reconnecting after 1, 2, 4 … up to 30 seconds. */
export function connectHub(o: HubSocketOptions): { close(): void } {
  const url = o.url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const create = o.createSocket ?? ((u: string) => new WebSocket(u));
  const schedule = o.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  let attempt = 0;
  let closed = false;
  let socket: WebSocket | null = null;

  const open = () => {
    if (closed) return;
    o.onStatus('connecting');
    const s = create(url);
    socket = s;
    s.onopen = () => s.send(JSON.stringify({ type: 'auth', token: o.token }));
    s.onmessage = (ev) => {
      let e: { type?: string };
      try {
        e = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (e.type === 'ready') {
        attempt = 0;
        o.onStatus('open');
        o.onReady();
      } else {
        o.onEvent(e as HubEvent);
      }
    };
    s.onclose = (ev) => {
      socket = null;
      if (closed) return;
      if (ev.code === 4001) {
        o.onUnauthorized();
        return;
      }
      o.onStatus('closed');
      const delay = Math.min(30000, 1000 * 2 ** attempt);
      attempt++;
      schedule(open, delay);
    };
  };

  open();
  return {
    close() {
      closed = true;
      socket?.close();
    },
  };
}
