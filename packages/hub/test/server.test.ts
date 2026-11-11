import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { FakeAdapter } from '@agent-chat/adapters';
import { seed } from '../src/bootstrap';
import { ConfigStore } from '../src/config';
import { Scheduler } from '../src/scheduler';
import { Bus, buildServer } from '../src/server';
import { Store } from '../src/store';

let app: FastifyInstance;
let store: Store;
let config: ConfigStore;
let fa: FakeAdapter;
let fb: FakeAdapter;
let dataDir: string;
let auth: { authorization: string };

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
  dataDir = mkdtempSync(join(tmpdir(), 'agentchat-srv-'));
  store = new Store(':memory:');
  config = new ConfigStore(dataDir);
  fa = new FakeAdapter('fake-a', 'A');
  fb = new FakeAdapter('fake-b', 'B');
  seed(store, [fa, fb]);
  const bus = new Bus();
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
  app = buildServer({ store, scheduler, config, bus, availability });
  auth = { authorization: `Bearer ${config.get().token}` };
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

describe('auth', () => {
  it('rejects requests without the token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer wrong' } })).statusCode,
    ).toBe(401);
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

  it('stores the triage key but never returns it', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: auth,
      payload: { triage: { baseUrl: 'http://x/v1', apiKey: 'secret', model: 'm' }, dsh: { provider: 'my-provider', model: 'd' } },
    });
    expect(put.json()).toEqual({ triage: { baseUrl: 'http://x/v1', model: 'm', hasKey: true }, dsh: { provider: 'my-provider', model: 'd' } });
    expect(JSON.stringify((await app.inject({ method: 'GET', url: '/api/config', headers: auth })).json())).not.toContain('secret');
    expect(config.get().triage!.apiKey).toBe('secret');
  });

  it('updates a member bio', async () => {
    const s = await state();
    const a = s.members.find((m: any) => m.name === 'A');
    const res = await app.inject({ method: 'PATCH', url: `/api/members/${a.id}`, headers: auth, payload: { bio: '新介绍' } });
    expect(res.json().bio).toBe('新介绍');
  });
});

describe('attachments', () => {
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
    ws.send(JSON.stringify({ type: 'auth', token: config.get().token }));
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
