import { describe, expect, it } from 'vitest';
import { buildPrompt, toResult, PASS_TOKEN, FakeAdapter, AdapterError } from '../src/index';
import type { InvokeRequest } from '../src/index';

const base: InvokeRequest = {
  conversationId: 'c1',
  agentName: 'Codex',
  conversationTitle: '闲聊群',
  isGroup: true,
  harnessSessionId: null,
  newMessages: [
    { id: 'm1', senderName: '小明', body: '大家好', createdAt: 0, attachments: [] },
    { id: 'm2', senderName: 'Claude Code', body: '你好', createdAt: 0, attachments: ['/w/a.png'] },
  ],
  workdir: '/w',
  signal: new AbortController().signal,
  timeoutMs: 1000,
};

describe('buildPrompt', () => {
  it('includes identity, messages, attachments and the pass rule in groups', () => {
    const p = buildPrompt(base);
    expect(p).toContain('You are "Codex"');
    expect(p).toContain('group chat "闲聊群"');
    expect(p).toContain('小明: 大家好');
    expect(p).toContain('Claude Code: 你好');
    expect(p).toContain('/w/a.png');
    expect(p).toContain(PASS_TOKEN);
  });

  it('omits the pass rule in private chats', () => {
    const p = buildPrompt({ ...base, isGroup: false });
    expect(p).toContain('a private chat');
    expect(p).not.toContain(PASS_TOKEN);
  });
});

describe('toResult', () => {
  it('returns a reply for normal text', () => {
    expect(toResult('  hi  ', 's1', true)).toEqual({ kind: 'reply', body: 'hi', harnessSessionId: 's1' });
  });
  it('returns silent for the pass token in a group', () => {
    expect(toResult(` ${PASS_TOKEN}\n`, 's1', true)).toEqual({ kind: 'silent', harnessSessionId: 's1' });
  });
  it('treats the pass token as a reply in a private chat', () => {
    expect(toResult(PASS_TOKEN, 's1', false).kind).toBe('reply');
  });
  it('throws crashed on empty text', () => {
    expect(() => toResult('   ', 's1', true)).toThrow(AdapterError);
  });
});

describe('FakeAdapter', () => {
  it('records calls and returns the scripted result', async () => {
    const a = new FakeAdapter('fake-a', 'A');
    const r = await a.invoke(base);
    expect(r).toEqual({ kind: 'reply', body: 'reply from A', harnessSessionId: 'fake-a-session' });
    expect(a.calls).toHaveLength(1);
    a.handler = async () => ({ kind: 'silent', harnessSessionId: 'x' });
    expect((await a.invoke(base)).kind).toBe('silent');
  });
});
