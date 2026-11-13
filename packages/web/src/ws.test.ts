import { describe, expect, it } from 'vitest';
import type { HubEvent } from './types';
import { connectHub, type WsStatus } from './ws';

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.onclose?.({ code: 1000 });
  }
}

function start() {
  FakeSocket.all = [];
  const statuses: WsStatus[] = [];
  const events: HubEvent[] = [];
  const timers: Array<[() => void, number]> = [];
  let ready = 0;
  let unauthorized = 0;
  const client = connectHub({
    token: 'tok',
    url: 'ws://hub/ws',
    createSocket: (u) => new FakeSocket(u) as unknown as WebSocket,
    schedule: (fn, ms) => void timers.push([fn, ms]),
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    onReady: () => ready++,
    onUnauthorized: () => unauthorized++,
  });
  return { client, statuses, events, timers, ready: () => ready, unauthorized: () => unauthorized, socket: () => FakeSocket.all.at(-1)! };
}

describe('connectHub', () => {
  it('authenticates on open, reports ready, then forwards events', () => {
    const t = start();
    t.socket().onopen!();
    expect(JSON.parse(t.socket().sent[0])).toEqual({ type: 'auth', token: 'tok' });
    t.socket().onmessage!({ data: JSON.stringify({ type: 'ready' }) });
    expect(t.statuses).toEqual(['connecting', 'open']);
    expect(t.ready()).toBe(1);
    t.socket().onmessage!({ data: JSON.stringify({ type: 'stopped', stopped: true }) });
    expect(t.events).toEqual([{ type: 'stopped', stopped: true }]);
  });

  it('reconnects with a growing delay, reset after ready', () => {
    const t = start();
    t.socket().onclose!({ code: 1006 });
    expect(t.statuses.at(-1)).toBe('closed');
    expect(t.timers.map(([, ms]) => ms)).toEqual([1000]);
    t.timers[0][0]();
    t.socket().onclose!({ code: 1006 });
    expect(t.timers.map(([, ms]) => ms)).toEqual([1000, 2000]);
    t.timers[1][0]();
    t.socket().onmessage!({ data: JSON.stringify({ type: 'ready' }) });
    t.socket().onclose!({ code: 1006 });
    expect(t.timers.at(-1)![1]).toBe(1000);
  });

  it('stops on 4001 and reports unauthorized', () => {
    const t = start();
    t.socket().onclose!({ code: 4001 });
    expect(t.unauthorized()).toBe(1);
    expect(t.timers).toEqual([]);
  });

  it('close() stops reconnecting', () => {
    const t = start();
    t.client.close();
    expect(t.timers).toEqual([]);
  });
});
