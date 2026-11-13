import type { Availability, Conversation, Message, StateResponse } from './types';

export class UnauthorizedError extends Error {}
export class HubDownError extends Error {}
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApi(token: string, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchImpl(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new HubDownError('hub 没有运行');
    }
    if (res.status === 401) throw new UnauthorizedError('访问令牌无效');
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (data as { error?: unknown } | null)?.error;
      throw new ApiError(res.status, typeof msg === 'string' ? msg : `HTTP ${res.status}`);
    }
    return data as T;
  }
  const conv = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;
  return {
    state: () => call<StateResponse>('GET', '/api/state'),
    messages: (id: string, beforeSeq?: number) =>
      call<Message[]>('GET', `${conv(id)}/messages?limit=50${beforeSeq !== undefined ? `&beforeSeq=${beforeSeq}` : ''}`),
    send: (id: string, body: string) => call<Message>('POST', `${conv(id)}/messages`, { body }),
    createGroup: (title: string, memberIds: string[]) => call<Conversation>('POST', '/api/conversations', { title, memberIds }),
    setPaused: (id: string, paused: boolean) => call<Conversation>('PATCH', `${conv(id)}/settings`, { paused }),
    stop: () => call<{ stopped: boolean }>('POST', '/api/stop'),
    resume: () => call<{ stopped: boolean }>('POST', '/api/resume'),
    refreshAvailability: () => call<Record<string, Availability>>('POST', '/api/availability/refresh'),
  };
}

export type Api = ReturnType<typeof createApi>;
