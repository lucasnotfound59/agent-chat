import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { FakeAdapter } from '@agent-chat/adapters';
import { seed } from '../src/bootstrap';
import { ConfigStore } from '../src/config';
import { MemoryTokenStore, ensureToken } from '../src/tokenStore';
import { Scheduler } from '../src/scheduler';
import { Bus, buildServer } from '../src/server';
import { Store } from '../src/store';
import { AskService } from '../src/ask';
import { AdapterError } from '@agent-chat/adapters';
import http from 'node:http';

let app: FastifyInstance;
let bus: Bus;
let store: Store;
let config: ConfigStore;
let tokenStore: MemoryTokenStore;
let token: string;
let fa: FakeAdapter;
let fb: FakeAdapter;
let dataDir: string;
let auth: { authorization: string };
let refreshCalls = 0;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await wait(10);
  }
}

beforeEach(() => {
  refreshCalls = 0;
  dataDir = mkdtempSync(join(tmpdir(), 'agentchat-srv-'));
  store = new Store(':memory:');
  config = new ConfigStore(dataDir);
  tokenStore = new MemoryTokenStore(ensureToken(new MemoryTokenStore(), null));
  token = tokenStore.get()!;
  fa = new FakeAdapter('fake-a', 'A');
  fb = new FakeAdapter('fake-b', 'B');
  seed(store, [fa, fb]);
  bus = new Bus();
  const availability = new Map([
    ['fake-a', { ok: true }],
    ['fake-b', { ok: false, reason: '未登录' }],
  ]);
  const scheduler = new Scheduler({
    store,
    adapters: new Map([
      [fa.name, fa],
      [fb.name, fb],
    ]),
    triage: () => null,
    emit: (e) => bus.emit(e),
    dataDir,
    isAvailable: (n) => availability.get(n)?.ok ?? false,
  });
  const ask = new AskService({
    store,
    scheduler,
    isAvailable: (n) => availability.get(n)?.ok ?? false,
    availabilityReason: (n) => availability.get(n)?.reason,
    emit: (e) => bus.emit(e),
  });
  app = buildServer({
    store,
    scheduler,
    config,
    token: () => tokenStore.get()!,
    bus,
    availability,
    ask,
    refreshAvailability: async () => {
      refreshCalls++;
    },
  });
  auth = { authorization: `Bearer ${token}` };
});

afterEach(async () => {
  await app.close();
});

const state = async () => (await app.inject({ method: 'GET', url: '/api/state', headers: auth })).json();

describe('seed', () => {
  it('creates the human, one agent per adapter and their private chats, once', () => {
    seed(store, [fa, fb]);
    expect(store.listMembers().map((m) => m.name)).toEqual(['我', 'A', 'B']);
    expect(store.listMembers()[1]).toMatchObject({ kind: 'agent', adapter: 'fake-a', bio: fa.defaultBio });
    expect(store.listConversations().map((c) => `${c.kind}:${c.title}`)).toEqual(['dm:A', 'dm:B']);
  });
});

describe('Bus', () => {
  it('delivers to remaining listeners when one throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = new Bus();
    const got: string[] = [];
    b.on(() => {
      throw new Error('boom');
    });
    b.on((e) => got.push(e.type));
    expect(() => b.emit({ type: 'ready' } as any)).not.toThrow();
    expect(got).toEqual(['ready']);
    expect(spy).toHaveBeenCalledWith('[bus] listener failed', expect.any(Error));
    spy.mockRestore();
  });
});

describe('auth', () => {
  it('rejects requests without the token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer wrong' } })).statusCode,
    ).toBe(401);
  });
});

describe('auth bypass hardening', () => {
  it('denies encoded-path and unmatched routes without a token', async () => {
    const s = await state();
    for (const [method, url] of [
      ['GET', '/%61pi/state'],
      ['POST', '/%61pi/stop'],
      ['GET', '/%61pi/attachments/x'],
      ['GET', '/nope'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
    }
    expect(s.stopped).toBe(false);
    expect((await state()).stopped).toBe(false);
  });

  it('rejects a foreign Host header even with a valid token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/state', headers: { ...auth, host: 'evil.example' } });
    expect(res.statusCode).toBe(403);
    const ok = await app.inject({ method: 'GET', url: '/api/state', headers: { ...auth, host: '127.0.0.1:4317' } });
    expect(ok.statusCode).toBe(200);
  });

  it('closes a websocket whose first message is not a valid auth and sends it no events', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const received: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello' }));
    await new Promise((r) => ws.on('close', r));
    const s = await state();
    const dm = s.conversations.find((c: any) => c.title === 'A');
    await app.inject({ method: 'POST', url: `/api/conversations/${dm.id}/messages`, headers: auth, payload: { body: 'hi' } });
    await wait(50);
    expect(received).toEqual([]);
  });
});

describe('state', () => {
  it('returns me, members with availability, conversations and the stop flag', async () => {
    const s = await state();
    expect(s.me.name).toBe('我');
    expect(s.members.find((m: any) => m.name === 'B').availability).toEqual({ ok: false, reason: '未登录' });
    expect(s.members.find((m: any) => m.name === '我').availability).toBeNull();
    expect(s.conversations).toHaveLength(2);
    expect(s.stopped).toBe(false);
  });
});

describe('messages', () => {
  it('stores a message, lets the agent reply, and lists history', async () => {
    const s = await state();
    const dm = s.conversations.find((c: any) => c.title === 'A');
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${dm.id}/messages`,
      headers: auth,
      payload: { body: '在吗' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ body: '在吗', senderId: s.me.id, kind: 'normal' });
    await until(() => store.listMessages(dm.id).length === 2);
    const list = await app.inject({ method: 'GET', url: `/api/conversations/${dm.id}/messages?limit=1`, headers: auth });
    expect(list.json().map((m: any) => m.body)).toEqual(['reply from A']);
  });

  it('still answers when a bus listener throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.on(() => {
      throw new Error('bad listener');
    });
    const s = await state();
    const dm = s.conversations.find((c: any) => c.title === 'A');
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${dm.id}/messages`,
      headers: auth,
      payload: { body: '在吗' },
    });
    expect(res.statusCode).toBe(200);
    await until(() => store.listMessages(dm.id).length === 2);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('parses mentions from the body', async () => {
    const s = await state();
    const a = s.members.find((m: any) => m.name === 'A');
    const group = (
      await app.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: auth,
        payload: { title: '群', memberIds: [a.id] },
      })
    ).json();
    expect(group.kind).toBe('group');
    expect(group.memberIds).toContain(s.me.id);
    await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${group.id}/settings`,
      headers: auth,
      payload: { debounceMs: 10 },
    });
    const msg = (
      await app.inject({
        method: 'POST',
        url: `/api/conversations/${group.id}/messages`,
        headers: auth,
        payload: { body: '@A 你好' },
      })
    ).json();
    expect(msg.mentions).toEqual([a.id]);
    await until(() => fa.calls.length === 1);
  });

  it('rejects empty messages and unknown conversations', async () => {
    const s = await state();
    const id = s.conversations[0].id;
    const empty = await app.inject({ method: 'POST', url: `/api/conversations/${id}/messages`, headers: auth, payload: { body: '  ' } });
    expect(empty.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/conversations/nope/messages', headers: auth, payload: { body: 'x' } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('settings, stop and config', () => {
  it('pauses a conversation and reports it', async () => {
    const s = await state();
    const id = s.conversations[0].id;
    const res = await app.inject({ method: 'PATCH', url: `/api/conversations/${id}/settings`, headers: auth, payload: { paused: true } });
    expect(res.json().settings.paused).toBe(true);
    await app.inject({ method: 'POST', url: `/api/conversations/${id}/messages`, headers: auth, payload: { body: 'hi' } });
    await wait(50);
    expect(fa.calls).toHaveLength(0);
    await app.inject({ method: 'PATCH', url: `/api/conversations/${id}/settings`, headers: auth, payload: { paused: false } });
    await until(() => fa.calls.length === 1);
  });

  it('ignores unknown settings keys', async () => {
    const s = await state();
    const id = s.conversations[0].id;
    const res = await app.inject({ method: 'PATCH', url: `/api/conversations/${id}/settings`, headers: auth, payload: { bogus: 1, maxAgentRounds: 3 } });
    expect(res.json().settings.maxAgentRounds).toBe(3);
    expect(res.json().settings.bogus).toBeUndefined();
  });

  it('stops and resumes globally', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/stop', headers: auth })).json()).toEqual({ stopped: true });
    expect((await state()).stopped).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/resume', headers: auth })).json()).toEqual({ stopped: false });
  });

  it('stores the triage agent and dsh settings and returns no key fields', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: auth,
      payload: { triageAgent: 'fake-a', dsh: { provider: 'my-provider', model: 'd' } },
    });
    expect(put.json()).toEqual({ triageAgent: 'fake-a', dsh: { provider: 'my-provider', model: 'd' } });
    const got = (await app.inject({ method: 'GET', url: '/api/config', headers: auth })).json();
    expect(got).toEqual({ triageAgent: 'fake-a', dsh: { provider: 'my-provider', model: 'd' } });
    expect(config.get().triageAgent).toBe('fake-a');
  });

  it('accepts off and null for triageAgent and ignores unknown values', async () => {
    const put = (triageAgent: any) => app.inject({ method: 'PUT', url: '/api/config', headers: auth, payload: { triageAgent } });
    expect((await put('off')).json().triageAgent).toBe('off');
    expect((await put('nope')).json().triageAgent).toBe('off');
    expect((await put(5)).json().triageAgent).toBe('off');
    expect((await put(null)).json().triageAgent).toBeNull();
    expect((await put('fake-b')).json().triageAgent).toBe('fake-b');
    expect((await put('nope')).json().triageAgent).toBe('fake-b');
  });

  it('updates a member bio', async () => {
    const s = await state();
    const a = s.members.find((m: any) => m.name === 'A');
    const res = await app.inject({ method: 'PATCH', url: `/api/members/${a.id}`, headers: auth, payload: { bio: '新介绍' } });
    expect(res.json().bio).toBe('新介绍');
  });

  it('POST /api/availability/refresh re-checks and returns every adapter', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/availability/refresh' })).statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/api/availability/refresh', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(refreshCalls).toBe(1);
    expect(r.json()).toEqual({ 'fake-a': { ok: true }, 'fake-b': { ok: false, reason: '未登录' } });
  });
});

describe('attachments', () => {
  it('drops attachments that escape the conversation folder', async () => {
    const s = await state();
    const id = s.conversations[0].id;
    const up = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/attachments?name=ok.txt`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    const good = up.json();
    const evil = { name: 'x', file: `${id}/../../config.json` };
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages`,
      headers: auth,
      payload: { body: 'see', attachments: [evil, good] },
    });
    expect(res.json().attachments).toEqual([good]);
    const only = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages`,
      headers: auth,
      payload: { body: '', attachments: [evil] },
    });
    expect(only.statusCode).toBe(400);
  });

  it('uploads, serves, and blocks path traversal', async () => {
    const s = await state();
    const id = s.conversations[0].id;
    const up = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/attachments?name=${encodeURIComponent('笔记 1.txt')}`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('hello'),
    });
    expect(up.statusCode).toBe(200);
    const att = up.json();
    expect(att.name).toBe('笔记 1.txt');
    expect(att.file.startsWith(`${id}/`)).toBe(true);
    expect(readFileSync(join(dataDir, 'attachments', att.file), 'utf8')).toBe('hello');
    const get = await app.inject({ method: 'GET', url: `/api/attachments/${att.file}`, headers: auth });
    expect(get.body).toBe('hello');
    const bad = await app.inject({ method: 'GET', url: '/api/attachments/..%2Fconfig.json', headers: auth });
    expect(bad.statusCode).toBe(404);
  });
});

describe('websocket', () => {
  it('requires auth, then pushes message events', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const received: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'auth', token: token }));
    await until(() => received.some((e) => e.type === 'ready'));

    const s = await state();
    const dm = s.conversations.find((c: any) => c.title === 'A');
    await app.inject({ method: 'POST', url: `/api/conversations/${dm.id}/messages`, headers: auth, payload: { body: 'hi' } });
    await until(() => received.filter((e) => e.type === 'message').length === 2);
    expect(received.filter((e) => e.type === 'message').map((e) => e.message.body)).toEqual(['hi', 'reply from A']);
    ws.close();

    const bad = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => bad.on('open', r));
    bad.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    await new Promise((r) => bad.on('close', r));
  });
});

describe('ask routes', () => {
  const post = (body: unknown, headers: Record<string, string> = auth) =>
    app.inject({ method: 'POST', url: '/api/ask', headers, payload: body as any });
  // fake-b is unavailable in this fixture, so B asks A.
  const good = { as: 'fake-b', to: 'A', question: '在吗' };

  it('answers with 200 and the conversation id', async () => {
    const r = await post(good);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ reply: 'reply from A' });
    expect(store.getConversation(r.json().conversationId)?.kind).toBe('ask');
  });

  it('requires the token', async () => {
    expect((await post(good, {})).statusCode).toBe(401);
  });

  it('maps error codes to HTTP statuses', async () => {
    const cases: Array<[() => Promise<any>, number, string]> = [
      [() => post({ ...good, question: ' ' }), 400, 'bad_request'],
      [() => post({ ...good, as: 'fake-a', to: 'B' }), 409, 'unavailable'],
    ];
    for (const [run, status, code] of cases) {
      const r = await run();
      expect(r.statusCode).toBe(status);
      expect(r.json()).toMatchObject({ code, error: expect.any(String) });
    }
    fa.handler = async () => {
      throw new AdapterError('timeout', 'slow');
    };
    expect((await post(good)).statusCode).toBe(504);
    fa.handler = async () => {
      throw new AdapterError('crashed', 'boom');
    };
    expect((await post(good)).statusCode).toBe(502);
    expect((await app.inject({ method: 'POST', url: '/api/stop', headers: auth })).statusCode).toBe(200);
    const stopped = await post(good);
    expect(stopped.statusCode).toBe(503);
    expect(stopped.json().code).toBe('stopped');
    await app.inject({ method: 'POST', url: '/api/resume', headers: auth });
    const conv = store.listConversations().find((c) => c.kind === 'ask')!;
    store.updateSettings(conv.id, { dailyInvocationCap: 0 });
    expect((await post(good)).statusCode).toBe(429);
  });

  it('retry answers started:false with a reason when the scheduler would refuse', async () => {
    const retry = (id: string) => app.inject({ method: 'POST', url: `/api/invocations/${id}/retry`, headers: auth });
    expect((await retry('nope')).json()).toEqual({ started: false, reason: 'not_found' });
    fa.handler = async () => {
      throw new AdapterError('crashed', 'boom');
    };
    expect((await post(good)).statusCode).toBe(502);
    const conv = store.listConversations().find((c) => c.kind === 'ask')!;
    const invocationId = store.listMessages(conv.id).find((m) => m.kind === 'system')!.meta!.invocationId as string;
    // an ask invocation is never retried through the round scheduler, so the route must not claim it started
    expect((await retry(invocationId)).json()).toEqual({ started: false, reason: 'ask' });
  });

  it('lists members with availability', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/members', headers: auth });
    expect(r.json()).toEqual([
      { name: '我', adapter: null, kind: 'human', bio: '', available: true, reason: null },
      { name: 'A', adapter: 'fake-a', kind: 'agent', bio: fa.defaultBio, available: true, reason: null },
      { name: 'B', adapter: 'fake-b', kind: 'agent', bio: fb.defaultBio, available: false, reason: '未登录' },
    ]);
  });

  it('rejects human messages into an ask conversation', async () => {
    const id = (await post(good)).json().conversationId;
    const r = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages`,
      headers: auth,
      payload: { body: 'hello' },
    });
    expect(r.statusCode).toBe(400);
    expect(store.listMessages(id).some((m) => m.body === 'hello')).toBe(false);
  });

  it('aborts the invocation when the client disconnects, but not after a normal response', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const send = (onReq?: (r: http.ClientRequest) => void) =>
      new Promise<number>((resolve, reject) => {
        const body = JSON.stringify(good);
        const r = http.request(
          { host: '127.0.0.1', port, path: '/api/ask', method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        r.on('error', () => resolve(0));
        r.end(body);
        onReq?.(r);
      });

    // Normal completion leaves the signal alone.
    expect(await send()).toBe(200);
    await wait(30);
    expect(fa.calls[0].signal.aborted).toBe(false);

    fa.handler = (req) =>
      new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new AdapterError('aborted', 'x'))));
    const pending = send((r) => setTimeout(() => r.destroy(), 60));
    await until(() => fa.calls.length === 2);
    await pending;
    await until(() => fa.calls[1].signal.aborted);
    const conv = store.listConversations().find((c) => c.kind === 'ask')!;
    await until(() => store.listInvocations(conv.id).length === 2 && store.listInvocations(conv.id)[1].outcome);
    expect(store.listInvocations(conv.id).map((i) => i.outcome)).toEqual(['replied', 'interrupted']);
  });
});
