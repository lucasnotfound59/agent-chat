import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import { DEFAULT_SETTINGS } from '../src/types';

let store: Store;
let human: string, a: string, b: string, group: string;

beforeEach(() => {
  store = new Store(':memory:');
  human = store.createMember({ kind: 'human', name: '我' }).id;
  a = store.createMember({ kind: 'agent', name: 'A', bio: 'agent a', adapter: 'fake-a' }).id;
  b = store.createMember({ kind: 'agent', name: 'B', adapter: 'fake-b' }).id;
  group = store.createConversation({ kind: 'group', title: 'G', memberIds: [human, a, b] }).id;
});

describe('members', () => {
  it('creates, lists, gets and updates bio', () => {
    expect(store.listMembers().map((m) => m.name)).toEqual(['我', 'A', 'B']);
    expect(store.getMember(a)).toMatchObject({ kind: 'agent', bio: 'agent a', adapter: 'fake-a' });
    expect(store.getMember('nope')).toBeNull();
    store.updateMemberBio(a, 'new bio');
    expect(store.getMember(a)!.bio).toBe('new bio');
  });
});

describe('conversations', () => {
  it('stores members and default settings', () => {
    const c = store.getConversation(group)!;
    expect(c.settings).toEqual(DEFAULT_SETTINGS);
    expect(c.memberIds.sort()).toEqual([human, a, b].sort());
    expect(store.listConversationMembers(group).map((m) => m.name).sort()).toEqual(['A', 'B', '我']);
    expect(store.listConversations()).toHaveLength(1);
    expect(store.getConversation('nope')).toBeNull();
  });
  it('merges settings patches', () => {
    const c = store.updateSettings(group, { paused: true, maxAgentRounds: 2 });
    expect(c.settings).toEqual({ ...DEFAULT_SETTINGS, paused: true, maxAgentRounds: 2 });
    expect(store.getConversation(group)!.settings.paused).toBe(true);
  });
});

describe('messages', () => {
  it('assigns increasing seq and round-trips all fields', () => {
    const m1 = store.addMessage({ conversationId: group, senderId: human, body: 'hi @A', mentions: [a] });
    const m2 = store.addMessage({
      conversationId: group,
      senderId: null,
      kind: 'system',
      body: 'note',
      meta: { invocationId: 'i1', retryable: true },
      attachments: [{ name: 'x.png', file: 'g/x.png' }],
      replyTo: m1.id,
    });
    expect(m2.seq).toBeGreaterThan(m1.seq);
    expect(m1).toMatchObject({ kind: 'normal', mentions: [a], attachments: [], meta: null, replyTo: null });
    const all = store.listMessages(group);
    expect(all.map((m) => m.id)).toEqual([m1.id, m2.id]);
    expect(all[1]).toEqual(m2);
  });
  it('pages backwards with beforeSeq and limit', () => {
    const ms = [1, 2, 3, 4, 5].map((i) => store.addMessage({ conversationId: group, senderId: human, body: `m${i}` }));
    expect(store.listMessages(group, { limit: 2 }).map((m) => m.body)).toEqual(['m4', 'm5']);
    expect(store.listMessages(group, { beforeSeq: ms[3].seq, limit: 2 }).map((m) => m.body)).toEqual(['m2', 'm3']);
  });
  it('lists messages after a seq and reports maxSeq', () => {
    expect(store.maxSeq(group)).toBe(0);
    const m1 = store.addMessage({ conversationId: group, senderId: human, body: 'one' });
    const m2 = store.addMessage({ conversationId: group, senderId: a, body: 'two' });
    expect(store.listMessagesAfter(group, m1.seq).map((m) => m.body)).toEqual(['two']);
    expect(store.maxSeq(group)).toBe(m2.seq);
  });
});

describe('agent sessions', () => {
  it('sets, gets and clears', () => {
    expect(store.getAgentSession(group, a)).toBeNull();
    store.setAgentSession(group, a, 's1', 3);
    store.setAgentSession(group, a, 's2', 7);
    expect(store.getAgentSession(group, a)).toEqual({ harnessSessionId: 's2', lastSeenSeq: 7 });
    store.clearAgentSession(group, a);
    expect(store.getAgentSession(group, a)).toBeNull();
  });
});

describe('invocations', () => {
  it('tracks outcome, counts by time and marks unfinished ones', () => {
    const before = Date.now();
    const i1 = store.startInvocation(group, a, 'round');
    const i2 = store.startInvocation(group, b, 'round');
    store.finishInvocation(i1, 'replied');
    expect(store.getInvocation(i1)).toMatchObject({ memberId: a, outcome: 'replied', reason: 'round' });
    expect(store.getInvocation(i1)!.endedAt).not.toBeNull();
    expect(store.countInvocationsSince(group, before)).toBe(2);
    expect(store.countInvocationsSince(group, Date.now() + 1000)).toBe(0);
    expect(store.markUnfinishedInterrupted()).toBe(1);
    expect(store.getInvocation(i2)!.outcome).toBe('interrupted');
  });
});
