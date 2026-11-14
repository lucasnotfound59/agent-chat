import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { TOKEN_KEY } from './token';

afterEach(() => window.localStorage.removeItem(TOKEN_KEY));

it('asks for the address printed by npm run hub when there is no token', () => {
  render(<App />);
  expect(screen.getByText(/npm run hub/)).toBeTruthy();
});

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor() {
    FakeSocket.instances.push(this);
  }
  send() {}
  close() {}
  serverClose(code = 1006) {
    this.onclose?.({ code });
  }
}

const BANNER = /页面会自动重连/;

describe('connection handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    window.localStorage.setItem(TOKEN_KEY, 'tok');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the hub-down banner when the socket closes before ready, and keeps it while retrying', async () => {
    render(<App />);
    expect(screen.queryByText(BANNER)).toBeNull();
    act(() => FakeSocket.instances[0].serverClose());
    expect(screen.getByText(BANNER)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(FakeSocket.instances.length).toBe(2);
    expect(screen.getByText(BANNER)).toBeTruthy();
  });

  it('keeps the expired screen after a 4001 close and later status events', async () => {
    render(<App />);
    act(() => FakeSocket.instances[0].serverClose(4001));
    expect(screen.getByText('访问令牌已失效。')).toBeTruthy();
    // a stray reconnect (e.g. another socket) must not bring the app back
    act(() => FakeSocket.instances[0].serverClose(1006));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText('访问令牌已失效。')).toBeTruthy();
    expect(screen.queryByText(BANNER)).toBeNull();
  });
});

describe('switching conversations', () => {
  const settings = { debounceMs: 0, maxAgentRounds: 1, dailyInvocationCap: 1, timeoutMs: 1, paused: false };
  const me = { id: 'h1', kind: 'human', name: 'me', bio: '', adapter: null };
  const agent = { id: 'a1', kind: 'agent', name: 'bot', bio: '', adapter: 'x', availability: { ok: true } };
  const msg = (conversationId: string, body: string) => ({
    id: `m-${conversationId}`, seq: 1, conversationId, senderId: 'h1', kind: 'normal', body,
    mentions: [], replyTo: null, attachments: [], meta: null, createdAt: 1,
  });
  const dm = { id: 'c-dm', kind: 'dm', title: 'bot', settings, memberIds: ['h1', 'a1'], createdAt: 1, lastMessage: null };
  const group = { id: 'c-group', kind: 'group', title: 'team', settings, memberIds: ['h1', 'a1'], createdAt: 2, lastMessage: null };
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/state')) return json({ me, members: [me, agent], conversations: [dm, group], stopped: false });
        if (url.includes('/c-dm/messages')) return json([msg('c-dm', 'hello from the private chat')]);
        if (url.includes('/c-group/messages')) return json([]);
        return json({});
      }),
    );
    window.localStorage.setItem(TOKEN_KEY, 'tok');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('replaces the message list instead of leaving the previous conversation behind', async () => {
    const { container } = render(<App />);
    await act(async () => {
      FakeSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'bot' }));
    });
    expect(await screen.findByText('hello from the private chat')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'team' }));
    });
    expect(container.querySelectorAll('.messages').length).toBe(1);
    expect(screen.queryByText('hello from the private chat')).toBeNull();
  });
});
