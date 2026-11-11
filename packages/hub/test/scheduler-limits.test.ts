import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterError } from '@agent-chat/adapters';
import type { InvokeRequest, InvokeResult } from '@agent-chat/adapters';
import { setup } from './helpers';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const hang = (req: InvokeRequest) =>
  new Promise<InvokeResult>((_, reject) => {
    req.signal.addEventListener('abort', () => reject(new AdapterError('aborted', 'aborted')));
  });

describe('consecutive agent rounds', () => {
  it('stops after maxAgentRounds agent-only rounds and resumes when the human speaks', async () => {
    const t = setup({ triage: true, settings: { maxAgentRounds: 2 } });
    t.triage.pickNames = 'ALL';
    t.say(t.group.id, '开始讨论');
    await t.settle();
    // 1 human-triggered round + 2 agent-only rounds, 2 agents each.
    expect(t.fa.calls.length + t.fb.calls.length).toBe(6);

    t.say(t.group.id, '继续');
    await t.settle();
    expect(t.fa.calls.length + t.fb.calls.length).toBe(12);
  });
});

describe('daily cap', () => {
  it('stops invoking and posts one system notice', async () => {
    const t = setup({ triage: true, settings: { dailyInvocationCap: 1, maxAgentRounds: 0 } });
    t.triage.pickNames = 'ALL';
    t.say(t.group.id, '一');
    await t.settle();
    t.say(t.group.id, '二');
    await t.settle();
    expect(t.fa.calls.length + t.fb.calls.length).toBe(1);
    const notices = t.store.listMessages(t.group.id).filter((m) => m.kind === 'system');
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain('上限');
  });
});

describe('pause', () => {
  it('invokes nobody while paused and catches up after kick', async () => {
    const t = setup();
    t.store.updateSettings(t.group.id, { paused: true });
    t.say(t.group.id, '@A 在吗', [t.a.id]);
    await t.settle();
    expect(t.fa.calls).toHaveLength(0);

    t.store.updateSettings(t.group.id, { paused: false });
    t.scheduler.kick(t.group.id);
    await t.settle();
    expect(t.fa.calls).toHaveLength(1);
  });

  it('abortConversation interrupts a running invocation', async () => {
    const t = setup();
    t.fa.handler = hang;
    const m = t.say(t.dm.id, 'hi');
    await vi.advanceTimersByTimeAsync(10);
    expect(t.fa.calls).toHaveLength(1);
    t.scheduler.abortConversation(t.dm.id);
    await t.settle();
    expect(t.bodies(t.dm.id)).toEqual(['hi']);
    expect(m.seq).toBeGreaterThan(0);
  });
});

describe('global stop', () => {
  it('aborts running work, blocks new work, and resumes on request', async () => {
    const t = setup();
    t.fa.handler = hang;
    t.say(t.dm.id, '一');
    await vi.advanceTimersByTimeAsync(10);
    t.scheduler.stopAll();
    await t.settle();
    expect(t.scheduler.isStopped()).toBe(true);
    expect(t.events.some((e) => e.type === 'stopped' && e.stopped)).toBe(true);
    expect(t.bodies(t.dm.id)).toEqual(['一']);

    t.fa.handler = async () => ({ kind: 'reply', body: 'back', harnessSessionId: 's' });
    t.say(t.dm.id, '二');
    await t.settle();
    expect(t.fa.calls).toHaveLength(1);

    t.scheduler.resumeAll();
    await t.settle();
    expect(t.fa.calls).toHaveLength(2);
    expect(t.bodies(t.dm.id)).toEqual(['一', '二', 'back']);
  });
});

describe('errors', () => {
  it('posts a retryable system message on timeout and retries on request', async () => {
    const t = setup();
    t.fa.handler = async () => {
      throw new AdapterError('timeout', 'no result');
    };
    t.say(t.dm.id, 'hi');
    await t.settle();
    const notice = t.store.listMessages(t.dm.id).at(-1)!;
    expect(notice.kind).toBe('system');
    expect(notice.body).toContain('超时');
    expect(notice.meta).toMatchObject({ retryable: true });
    const invocationId = notice.meta!.invocationId as string;
    expect(t.store.getInvocation(invocationId)!.outcome).toBe('timeout');

    t.fa.handler = async () => ({ kind: 'reply', body: 'now ok', harnessSessionId: 's' });
    expect(await t.scheduler.retryInvocation(invocationId)).toBe(true);
    await t.settle();
    expect(t.bodies(t.dm.id).at(-1)).toBe('now ok');
    expect(t.fa.calls[1].newMessages.map((m) => m.body)).toEqual(['hi']);
  });

  it('posts the error text when the agent crashes without a stored session', async () => {
    const t = setup();
    t.fa.handler = async () => {
      throw new AdapterError('crashed', 'boom');
    };
    t.say(t.dm.id, 'hi');
    await t.settle();
    const notice = t.store.listMessages(t.dm.id).at(-1)!;
    expect(notice.body).toContain('boom');
    expect(t.fa.calls).toHaveLength(1);
  });

  it('starts a fresh session with recent history when the stored session is lost', async () => {
    const t = setup();
    t.say(t.dm.id, '第一句');
    await t.settle();
    t.fa.handler = async (req) => {
      if (req.harnessSessionId) throw new AdapterError('crashed', 'unknown session');
      return { kind: 'reply', body: 'recovered', harnessSessionId: 'new-session' };
    };
    t.say(t.dm.id, '第二句');
    await t.settle();
    const last = t.fa.calls.at(-1)!;
    expect(last.harnessSessionId).toBeNull();
    expect(last.newMessages.map((m) => m.body)).toEqual(['第一句', 'reply from A', '第二句']);
    expect(t.store.getAgentSession(t.dm.id, t.a.id)!.harnessSessionId).toBe('new-session');
    expect(t.bodies(t.dm.id).at(-1)).toBe('recovered');
  });

  it('retryInvocation refuses unknown ids', async () => {
    const t = setup();
    expect(await t.scheduler.retryInvocation('nope')).toBe(false);
  });
});

describe('attachments', () => {
  it('copies attachments into the agent workdir and passes those paths', async () => {
    const t = setup();
    mkdirSync(join(t.dataDir, 'attachments', t.dm.id), { recursive: true });
    writeFileSync(join(t.dataDir, 'attachments', t.dm.id, 'note.txt'), 'hello');
    const m = t.store.addMessage({
      conversationId: t.dm.id,
      senderId: t.human.id,
      body: '看附件',
      attachments: [{ name: 'note.txt', file: `${t.dm.id}/note.txt` }],
    });
    t.scheduler.onMessage(m);
    await t.settle();
    const path = t.fa.calls[0].newMessages[0].attachments[0];
    expect(path).toBe(join(t.dataDir, 'workspaces', 'fake-a', 'attachments', t.dm.id, 'note.txt'));
    expect(existsSync(path)).toBe(true);
  });
});
