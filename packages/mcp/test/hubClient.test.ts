import { describe, expect, it } from 'vitest';
import { createHubClient, HubUnreachableError, readTokenFromKeychain, resolveBaseUrl } from '../src/hubClient';

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

describe('createHubClient redirects', () => {
  it('sends every request with redirect: error', async () => {
    const f = fakeFetch({ status: 200, body: [] });
    const c = createHubClient({ baseUrl: base, as: 'codex', getToken: () => 'tok', fetchImpl: f.fetchImpl });
    await c.listMembers();
    const g = fakeFetch({ status: 200, body: { reply: 'r' } });
    await createHubClient({ baseUrl: base, as: 'codex', getToken: () => 'tok', fetchImpl: g.fetchImpl }).ask('claude', 'q');
    expect(f.calls[0].init.redirect).toBe('error');
    expect(g.calls[0].init.redirect).toBe('error');
  });

  it('a real redirect is refused with a clear message', async () => {
    const http = await import('node:http');
    const srv = http.createServer((_q, res) => {
      res.statusCode = 307;
      res.setHeader('location', 'http://127.0.0.1:9/elsewhere');
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const c = createHubClient({ baseUrl: `http://127.0.0.1:${port}`, as: 'codex', getToken: () => 'tok' });
    const err = await c.ask('claude', 'q').catch((e) => e);
    await new Promise((r) => srv.close(r));
    expect(err).not.toBeInstanceOf(HubUnreachableError);
    expect(err.message).toBe('The hub answered with a redirect, which is not allowed.');
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

describe('resolveBaseUrl', () => {
  it('accepts a missing value and decimal ports 1-65535', () => {
    expect(resolveBaseUrl(undefined)).toBe('http://127.0.0.1:4317');
    expect(resolveBaseUrl('1')).toBe('http://127.0.0.1:1');
    expect(resolveBaseUrl('8080')).toBe('http://127.0.0.1:8080');
    expect(resolveBaseUrl('65535')).toBe('http://127.0.0.1:65535');
  });
  it.each(['4317@evil.example', '0', '65536', 'abc', '', ' 4317', '4317/x', '-1', '1e3', '123456'])('rejects %j', (v) => {
    expect(() => resolveBaseUrl(v)).toThrow();
  });
});

describe('createHubClient baseUrl guard', () => {
  const mk = (baseUrl: string) => () => createHubClient({ baseUrl, as: 'codex', getToken: () => 't' });
  it('accepts loopback hosts', () => {
    for (const u of ['http://127.0.0.1:4317', 'http://localhost:4317', 'http://[::1]:4317']) expect(mk(u)).not.toThrow();
  });
  it('rejects non-loopback hosts and userinfo', () => {
    for (const u of ['http://evil.example:4317', 'http://127.0.0.1:4317@evil.example', 'http://user:pw@127.0.0.1:4317', 'not a url'])
      expect(mk(u)).toThrow();
  });
});

describe('createHubClient edge cases', () => {
  it('a members body that is not an array is an unexpected-response error', async () => {
    const f = fakeFetch({ status: 200, body: { nope: 1 } });
    const c = createHubClient({ baseUrl: base, as: 'codex', getToken: () => 'tok', fetchImpl: f.fetchImpl });
    await expect(c.listMembers()).rejects.toThrow('The hub returned an unexpected members response.');
  });

  const hangingFetch = () => {
    const seen: AbortSignal[] = [];
    const fetchImpl = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        const s = init!.signal as AbortSignal;
        seen.push(s);
        s.addEventListener('abort', () => rej(s.reason));
      })) as unknown as typeof fetch;
    return { fetchImpl, seen };
  };

  it('a timeout is reported as a plain sentence, not as hub-not-running', async () => {
    const h = hangingFetch();
    const c = createHubClient({ baseUrl: base, as: 'codex', getToken: () => 'tok', fetchImpl: h.fetchImpl, timeoutMs: 20 });
    const err = await c.ask('claude', 'q').catch((e) => e);
    expect(err).not.toBeInstanceOf(HubUnreachableError);
    expect(err.message).toBe('The hub did not answer within 10 minutes.');
  });

  it('a caller cancellation aborts the fetch and is not hub-not-running', async () => {
    const h = hangingFetch();
    const c = createHubClient({ baseUrl: base, as: 'codex', getToken: () => 'tok', fetchImpl: h.fetchImpl });
    const ctl = new AbortController();
    const p = c.ask('claude', 'q', ctl.signal).catch((e) => e);
    ctl.abort();
    const err = await p;
    expect(h.seen[0].aborted).toBe(true);
    expect(err).not.toBeInstanceOf(HubUnreachableError);
  });
});
