import { describe, expect, it } from 'vitest';
import { PAGE, dmAgent, initialState, mergeMessages, reduce, sidebarGroups, type ChatState } from './store';
import type { Conversation, MemberView, Message, StateResponse } from './types';

const settings = { debounceMs: 3000, maxAgentRounds: 6, dailyInvocationCap: 200, timeoutMs: 300000, paused: false };
const me: MemberView = { id: 'me', kind: 'human', name: '我', bio: '', adapter: null, availability: null };
const alpha: MemberView = { id: 'a', kind: 'agent', name: 'Alpha', bio: '', adapter: 'fake-a', availability: { ok: true } };
const conv = (id: string, kind: Conversation['kind'], createdAt = 1, memberIds = ['me', 'a']): Conversation => ({
  id, kind, title: id, settings, memberIds, createdAt,
});
const msg = (id: string, conversationId: string, seq: number, senderId: string | null = 'a'): Message => ({
  id, seq, conversationId, senderId, kind: 'normal', body: id, mentions: [], replyTo: null, attachments: [], meta: null, createdAt: seq * 1000,
});
function loaded(): ChatState {
  const state: StateResponse = {
    me,
    members: [me, alpha],
    conversations: [
      { ...conv('dm1', 'dm'), lastMessage: msg('m1', 'dm1', 1) },
      { ...conv('g1', 'group', 2), lastMessage: null },
      { ...conv('ask1', 'ask', 3), lastMessage: msg('m2', 'ask1', 2) },
    ],
    stopped: false,
  };
  return reduce(initialState, { type: 'state', state });
}

describe('reduce', () => {
  it('loads state and keeps last messages apart from conversations', () => {
    const s = loaded();
    expect(s.me).toEqual(me);
    expect(s.conversations.map((c) => c.id)).toEqual(['dm1', 'g1', 'ask1']);
    expect('lastMessage' in s.conversations[0]).toBe(false);
    expect(s.lastMessage.dm1?.id).toBe('m1');
    expect(s.lastMessage.g1).toBeNull();
  });

  it('merges pages by id in seq order and tracks whether older messages remain', () => {
    let s = loaded();
    const page = Array.from({ length: PAGE }, (_, i) => msg(`p${i}`, 'dm1', 100 + i));
    s = reduce(s, { type: 'messages', conversationId: 'dm1', messages: page, older: false });
    expect(s.hasMore.dm1).toBe(true);
    s = reduce(s, { type: 'messages', conversationId: 'dm1', messages: [msg('old', 'dm1', 50), msg('p0', 'dm1', 100)], older: true });
    expect(s.messages.dm1[0].id).toBe('old');
    expect(s.messages.dm1.filter((m) => m.id === 'p0')).toHaveLength(1);
    expect(s.hasMore.dm1).toBe(false);
  });

  it('appends a message event only to a loaded conversation, without duplicates, and updates the last message', () => {
    let s = loaded();
    s = reduce(s, { type: 'event', event: { type: 'message', message: msg('m3', 'g1', 3) } });
    expect(s.messages.g1).toBeUndefined();
    expect(s.lastMessage.g1?.id).toBe('m3');
    s = reduce(s, { type: 'messages', conversationId: 'dm1', messages: [msg('m1', 'dm1', 1)], older: false });
    s = reduce(s, { type: 'event', event: { type: 'message', message: msg('m4', 'dm1', 4) } });
    s = reduce(s, { type: 'event', event: { type: 'message', message: msg('m4', 'dm1', 4) } });
    expect(s.messages.dm1.map((m) => m.id)).toEqual(['m1', 'm4']);
  });

  it('tracks typing per conversation', () => {
    let s = loaded();
    s = reduce(s, { type: 'event', event: { type: 'typing', conversationId: 'dm1', memberId: 'a', active: true } });
    s = reduce(s, { type: 'event', event: { type: 'typing', conversationId: 'dm1', memberId: 'a', active: true } });
    expect(s.typing.dm1).toEqual(['a']);
    s = reduce(s, { type: 'event', event: { type: 'typing', conversationId: 'dm1', memberId: 'a', active: false } });
    expect(s.typing.dm1).toEqual([]);
  });

  it('clears typing when state is reloaded (a missed typing-off must not stick)', () => {
    let s = loaded();
    s = reduce(s, { type: 'event', event: { type: 'typing', conversationId: 'dm1', memberId: 'a', active: true } });
    expect(s.typing.dm1).toEqual(['a']);
    s = reduce(s, { type: 'state', state: { me, members: [me, alpha], conversations: [], stopped: false } });
    expect(s.typing).toEqual({});
  });

  it('upserts conversations, sets stopped and updates availability', () => {
    let s = loaded();
    s = reduce(s, { type: 'event', event: { type: 'conversation', conversation: conv('g2', 'group', 9) } });
    s = reduce(s, { type: 'event', event: { type: 'conversation', conversation: { ...conv('g1', 'group', 2), title: '改名' } } });
    expect(s.conversations.map((c) => c.title)).toEqual(['dm1', '改名', 'ask1', 'g2']);
    s = reduce(s, { type: 'event', event: { type: 'stopped', stopped: true } });
    expect(s.stopped).toBe(true);
    s = reduce(s, { type: 'event', event: { type: 'availability', adapter: 'fake-a', availability: { ok: false, reason: '未登录' } } });
    expect(s.members.find((m) => m.id === 'a')?.availability).toEqual({ ok: false, reason: '未登录' });
  });

  it('records the connection status', () => {
    expect(reduce(initialState, { type: 'connection', connection: 'hub_down' }).connection).toBe('hub_down');
  });
});

describe('selectors', () => {
  it('groups the sidebar and sorts groups and asks by latest activity', () => {
    let s = loaded();
    s = reduce(s, { type: 'event', event: { type: 'conversation', conversation: conv('g2', 'group', 0) } });
    s = reduce(s, { type: 'event', event: { type: 'message', message: msg('m9', 'g2', 9) } });
    const g = sidebarGroups(s);
    expect(g.groups.map((c) => c.id)).toEqual(['g2', 'g1']);
    expect(g.dms.map((c) => c.id)).toEqual(['dm1']);
    expect(g.asks.map((c) => c.id)).toEqual(['ask1']);
  });

  it('finds the agent of a private chat', () => {
    const s = loaded();
    expect(dmAgent(s, s.conversations[0])?.name).toBe('Alpha');
  });

  it('mergeMessages keeps the incoming copy of a duplicate', () => {
    const a = msg('x', 'c', 1);
    expect(mergeMessages([a], [{ ...a, body: 'new' }])[0].body).toBe('new');
  });
});
