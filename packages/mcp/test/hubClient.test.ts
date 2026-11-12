import { describe, expect, it } from 'vitest';
import { createHubClient, HubUnreachableError, readTokenFromKeychain } from '../src/hubClient';

function fakeFetch(res: { status: number; body: unknown } | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (res instanceof Error) throw res;
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const base = 'http://127.0.0.1:4317';

describe('createHubClient', () => {
  it('ask posts as/to/question with the bearer token and returns the reply', async () => {
    const f = fakeFetch({ status: 200, body: { reply: 'hello', conversationId: 'c1' } });
    const c = createHubClient({ baseUrl: base, as: 'codex', getToken: () => 'tok', fetchImpl: f.fetchImpl });
    expect(await c.ask('claude', 'why?')).toBe('hello');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(`${base}/api/ask`);
    expect(f.calls[0].init.method).toBe('POST');
    const h = new Headers(f.calls[0].init.headers);
    expect(h.get('authorization')).toBe('Bearer tok');
    expect(h.get('content-type')).toBe('application/json');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ as: 'codex', to: 'claude', question: 'why?' });
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('merges the caller signal with the timeout', async () => {
    const f = fakeFetch({ status: 200, body: { reply: 'x' } });
    const c = createHubClient({ baseUrl: base, as: 'codex', getToken: () => 'tok', fetchImpl: f.fetchImpl });
    const ctl = new AbortController();
    await c.ask('claude', 'q', ctl.signal);
    const s = f.calls[0].init.signal as AbortSignal;
    expect(s.aborted).toBe(false);
    ctl.abort();
    expect(s.aborted).toBe(true);
  });

  it('listMembers does a GET with the token', async () => {
    const members = [{ name: 'claude', adapter: 'claude', kind: 'agent', bio: 'b', available: true, reason: null }];
    const f = fakeFetch({ status: 200, body: members });
    const c = createHubClient({ baseUrl: base, as: 'codex', getToken: () => 'tok', fetchImpl: f.fetchImpl });
    expect(await c.listMembers()).toEqual(members);
    expect(f.calls[0].url).toBe(`${base}/api/members`);
    expect(f.calls[0].init.method ?? 'GET').toBe('GET');
    expect(new Headers(f.calls[0].init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('a non-2xx response throws a plain Error carrying the hub error text', async () => {
    const f = fakeFetch({ status: 404, body: { error: 'no such member: zed', code: 'unknown_member' } });
    const c = createHubClient({ baseUrl: base, as: 'codex', getToken: () => 'tok', fetchImpl: f.fetchImpl });
    const err = await c.ask('zed', 'q').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HubUnreachableError);
    expect(err.message).toBe('no such member: zed');
  });

  it('a network error throws HubUnreachableError', async () => {
    const f = fakeFetch(new TypeError('fetch failed'));
    const c = createHubClient({ baseUrl: base, as: 'codex', getToken: () => 'tok', fetchImpl: f.fetchImpl });
    await expect(c.ask('claude', 'q')).rejects.toBeInstanceOf(HubUnreachableError);
    await expect(c.listMembers()).rejects.toBeInstanceOf(HubUnreachableError);
  });

  it('a missing token throws HubUnreachableError without calling the hub', async () => {
    const f = fakeFetch({ status: 200, body: {} });
    const c = createHubClient({ baseUrl: base, as: 'codex', getToken: () => null, fetchImpl: f.fetchImpl });
    await expect(c.ask('claude', 'q')).rejects.toBeInstanceOf(HubUnreachableError);
    await expect(c.listMembers()).rejects.toBeInstanceOf(HubUnreachableError);
    expect(f.calls).toHaveLength(0);
  });
});

describe('readTokenFromKeychain', () => {
  it('reads the AgentChat/hub-token item and trims the trailing newline', () => {
    let args: string[] = [];
    const t = readTokenFromKeychain((a) => {
      args = a;
      return { status: 0, stdout: 'secret\n' };
    });
    expect(t).toBe('secret');
    expect(args).toEqual(['find-generic-password', '-s', 'AgentChat', '-a', 'hub-token', '-w']);
  });

  it('returns null when not found (44) or on any other failure', () => {
    expect(readTokenFromKeychain(() => ({ status: 44, stdout: '' }))).toBeNull();
    expect(readTokenFromKeychain(() => ({ status: 1, stdout: '' }))).toBeNull();
  });

  it('returns null for an empty token', () => {
    expect(readTokenFromKeychain(() => ({ status: 0, stdout: '\n' }))).toBeNull();
  });
});
