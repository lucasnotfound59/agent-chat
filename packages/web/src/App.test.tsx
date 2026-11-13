import { act, render, screen } from '@testing-library/react';
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
