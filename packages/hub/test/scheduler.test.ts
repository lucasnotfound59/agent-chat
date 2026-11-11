import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup } from './helpers';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('private chat', () => {
  it('always invokes the agent, stores its reply and does not loop on its own message', async () => {
    const t = setup();
    t.say(t.dm.id, '在吗');
    await t.settle();
    expect(t.fa.calls).toHaveLength(1);
    expect(t.fa.calls[0]).toMatchObject({ isGroup: false, agentName: 'A', harnessSessionId: null });
    expect(t.fa.calls[0].newMessages.map((m) => `${m.senderName}:${m.body}`)).toEqual(['我:在吗']);
    expect(t.bodies(t.dm.id)).toEqual(['在吗', 'reply from A']);
    expect(t.store.getAgentSession(t.dm.id, t.a.id)!.harnessSessionId).toBe('fake-a-session');
  });

  it('resumes the stored session and sends only unseen messages', async () => {
    const t = setup();
    t.say(t.dm.id, '第一句');
    await t.settle();
    t.say(t.dm.id, '第二句');
    await t.settle();
    expect(t.fa.calls[1].harnessSessionId).toBe('fake-a-session');
    expect(t.fa.calls[1].newMessages.map((m) => m.body)).toEqual(['第二句']);
  });

  it('emits typing and message events', async () => {
    const t = setup();
    t.say(t.dm.id, 'hi');
    await t.settle();
    const kinds = t.events.map((e) => (e.type === 'typing' ? `typing:${e.active}` : e.type));
    expect(kinds).toEqual(['typing:true', 'message', 'typing:false']);
  });
});

describe('group chat without a triage model', () => {
  it('invokes nobody when nobody is mentioned', async () => {
    const t = setup();
    t.say(t.group.id, '大家好');
    await t.settle();
    expect(t.fa.calls).toHaveLength(0);
    expect(t.fb.calls).toHaveLength(0);
  });

  it('invokes only the mentioned agent', async () => {
    const t = setup();
    t.say(t.group.id, '@B 你怎么看', [t.b.id]);
    await t.settle();
    expect(t.fa.calls).toHaveLength(0);
    expect(t.fb.calls).toHaveLength(1);
    expect(t.fb.calls[0]).toMatchObject({ isGroup: true, conversationTitle: 'G' });
  });
});

describe('group chat with a triage model', () => {
  it('waits for a quiet period and merges messages into one round', async () => {
    const t = setup({ triage: true });
    t.triage.pickNames = ['A'];
    t.say(t.group.id, '一');
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.fa.calls).toHaveLength(0);
    t.say(t.group.id, '二');
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.fa.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.fa.calls).toHaveLength(1);
    expect(t.fa.calls[0].newMessages.map((m) => m.body)).toEqual(['一', '二']);
  });

  it('gives the triage model the non-mentioned candidates and the transcript', async () => {
    const t = setup({ triage: true });
    t.say(t.group.id, '@A 谁懂 Rust', [t.a.id]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.triage.calls[0].candidates).toEqual([{ id: t.b.id, name: 'B', bio: 'agent b' }]);
    expect(t.triage.calls[0].transcript).toEqual([{ sender: '我', body: '@A 谁懂 Rust' }]);
  });

  it('runs speakers one after another: mentioned first, then picks, each seeing earlier replies', async () => {
    const t = setup({ triage: true, settings: { maxAgentRounds: 0 } });
    t.triage.pickNames = ['A'];
    t.say(t.group.id, '@B 先说', [t.b.id]);
    await t.settle();
    expect(t.bodies(t.group.id)).toEqual(['@B 先说', 'reply from B', 'reply from A']);
    expect(t.fa.calls[0].newMessages.map((m) => m.body)).toEqual(['@B 先说', 'reply from B']);
  });

  it('stores nothing when a picked agent stays silent', async () => {
    const t = setup({ triage: true, settings: { maxAgentRounds: 0 } });
    t.triage.pickNames = ['A'];
    t.fa.handler = async () => ({ kind: 'silent', harnessSessionId: 's' });
    t.say(t.group.id, '嗯');
    await t.settle();
    expect(t.bodies(t.group.id)).toEqual(['嗯']);
    const inv = t.store.countInvocationsSince(t.group.id, 0);
    expect(inv).toBe(1);
  });

  it('does not re-send messages an agent already saw while staying silent', async () => {
    const t = setup({ triage: true, settings: { maxAgentRounds: 0 } });
    t.triage.pickNames = ['A'];
    t.fa.handler = async () => ({ kind: 'silent', harnessSessionId: 's' });
    t.say(t.group.id, '一');
    await t.settle();
    t.say(t.group.id, '二');
    await t.settle();
    expect(t.fa.calls[1].newMessages.map((m) => m.body)).toEqual(['二']);
  });

  it('falls back to mentions only when the triage model fails', async () => {
    const t = setup({ triage: true });
    t.triage.fail = true;
    t.say(t.group.id, '@B 在吗', [t.b.id]);
    await t.settle();
    expect(t.fb.calls).toHaveLength(1);
    expect(t.fa.calls).toHaveLength(0);
  });

  it('skips unavailable agents', async () => {
    const t = setup({ triage: true, settings: { maxAgentRounds: 0 } });
    t.triage.pickNames = 'ALL';
    t.unavailable.add('fake-a');
    t.say(t.group.id, '@A 大家说说', [t.a.id]);
    await t.settle();
    expect(t.fa.calls).toHaveLength(0);
    expect(t.fb.calls).toHaveLength(1);
  });

  it('records mentions that an agent writes in its reply', async () => {
    const t = setup({ triage: true, settings: { maxAgentRounds: 0 } });
    t.triage.pickNames = ['A'];
    t.fa.handler = async () => ({ kind: 'reply', body: '@B 你来', harnessSessionId: 's' });
    t.say(t.group.id, '问题');
    await t.settle();
    const reply = t.store.listMessages(t.group.id).at(-1)!;
    expect(reply.mentions).toEqual([t.b.id]);
  });
});
