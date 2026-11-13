import { describe, expect, it } from 'vitest';
import { ApiError, HubDownError, UnauthorizedError, createApi } from './api';

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('createApi', () => {
  it('sends the bearer token and a JSON body', async () => {
    const f = fakeFetch(200, { id: 'm1' });
    await createApi('tok', f.impl).send('c 1', '你好');
    expect(f.calls[0].url).toBe('/api/conversations/c%201/messages');
    expect(f.calls[0].init.method).toBe('POST');
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect((f.calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ body: '你好' });
  });

  it('pages messages with beforeSeq', async () => {
    const f = fakeFetch(200, []);
    await createApi('tok', f.impl).messages('c1', 42);
    expect(f.calls[0].url).toBe('/api/conversations/c1/messages?limit=50&beforeSeq=42');
  });

  it('maps 401, network failure and other errors', async () => {
    await expect(createApi('tok', fakeFetch(401, { error: 'unauthorized' }).impl).state()).rejects.toBeInstanceOf(UnauthorizedError);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(createApi('tok', down).state()).rejects.toBeInstanceOf(HubDownError);
    const err = await createApi('tok', fakeFetch(400, { error: 'empty message' }).impl)
      .send('c1', ' ')
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('empty message');
  });
});
