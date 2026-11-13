import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AdapterError } from '@agent-chat/adapters';
import type { InvokeRequest, InvokeResult } from '@agent-chat/adapters';
import { AskError, AskService } from '../src/ask';
import { Store } from '../src/store';
import { setup } from './helpers';

afterEach(() => vi.useRealTimers());

const hang = (req: InvokeRequest) =>
  new Promise<InvokeResult>((_, reject) => {
    req.signal.addEventListener('abort', () => reject(new AdapterError('aborted', 'aborted')));
  });

function make(opts: Parameters<typeof setup>[0] = {}) {
  const t = setup(opts);
  const svc = new AskService({
    store: t.store,
    scheduler: t.scheduler,
    isAvailable: (n) => !t.unavailable.has(n),
    availabilityReason: (n) => (t.unavailable.has(n) ? '未登录' : undefined),
    emit: (e) => t.events.push(e),
  });
  const ask = (o: { as?: string; to?: string; question?: string; signal?: AbortSignal }) =>
    svc.ask({ as: 'fake-b', to: 'A', question: '怎么做？', signal: new AbortController().signal, ...o });
  const failure = async (p: Promise<unknown>): Promise<AskError> => {
    try {
      await p;
    } catch (e) {
      return e as AskError;
    }
    throw new Error('expected rejection');
  };
  return { ...t, svc, ask, failure, askConvs: () => t.store.listConversations().filter((c) => c.kind === 'ask') };
}

describe('ask conversation', () => {
  it('creates an ask conversation, stores both messages and returns the answer', async () => {
    const t = make();
    t.fa.handler = async () => ({ kind: 'reply', body: '这样做', harnessSessionId: 's1' });
    const out = await t.ask({});
    expect(out.reply).toBe('这样做');
    const [conv] = t.askConvs();
    expect(out.conversationId).toBe(conv.id);
    expect(conv).toMatchObject({ kind: 'ask', title: 'B → A' });
    expect([...conv.memberIds].sort()).toEqual([t.a.id, t.b.id].sort());
    const msgs = t.store.listMessages(conv.id);
    expect(msgs.map((m) => [m.senderId, m.body])).toEqual([
      [t.b.id, '怎么做？'],
      [t.a.id, '这样做'],
    ]);
    expect(msgs[0].meta).toMatchObject({ via: 'mcp' });
    expect(t.fa.calls[0].isGroup).toBe(false);
    const types = t.events.map((e) => e.type);
    expect(types.indexOf('conversation')).toBeLessThan(types.indexOf('message'));
    expect(t.events.filter((e) => e.type === 'typing').map((e: any) => e.active)).toEqual([true, false]);
  });

  it('reuses the conversation and resumes the answerer session with only the new question', async () => {
    const t = make();
    t.fa.handler = async () => ({ kind: 'reply', body: 'ok', harnessSessionId: 'sess-1' });
    await t.ask({ question: '第一问' });
    await t.ask({ question: '第二问' });
    expect(t.askConvs()).toHaveLength(1);
    expect(t.fa.calls[1].harnessSessionId).toBe('sess-1');
    expect(t.fa.calls[1].newMessages.map((m) => m.body)).toEqual(['第二问']);
  });

  it('treats the opposite direction as another conversation', async () => {
    const t = make();
    await t.ask({});
    await t.ask({ as: 'fake-a', to: 'fake-b' });
    const convs = t.askConvs();
    expect(convs.map((c) => c.title).sort()).toEqual(['A → B', 'B → A']);
  });

  it('never schedules a round for the ask conversation, even after resumeAll', async () => {
    vi.useFakeTimers();
    const t = make({ triage: true });
    t.triage.pickNames = 'ALL';
    const p = t.ask({});
    await vi.advanceTimersByTimeAsync(10);
    await p;
    const before = t.fa.calls.length + t.fb.calls.length;
    await t.settle();
    t.scheduler.resumeAll();
    await t.settle();
    expect(t.fa.calls.length + t.fb.calls.length).toBe(before);
    expect(t.triage.calls).toHaveLength(0);
  });

  it('serializes concurrent asks in the same conversation', async () => {
    const t = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    t.fa.handler = async () => {
      n++;
      if (n === 1) await gate;
      return { kind: 'reply', body: `r${n}`, harnessSessionId: 's' };
    };
    const p1 = t.ask({ question: 'q1' });
    const p2 = t.ask({ question: 'q2' });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.fa.calls).toHaveLength(1);
    release();
    expect((await p1).reply).toBe('r1');
    expect((await p2).reply).toBe('r2');
    expect(t.fa.calls).toHaveLength(2);
    expect(t.fa.calls[0].newMessages.map((m) => m.body)).toEqual(['q1']);
    expect(t.fa.calls[1].newMessages.map((m) => m.body)).toEqual(['q2']);
  });

  it('presents each of several same-tick asks with exactly its own question', async () => {
    const t = make();
    const outs = await Promise.all([t.ask({ question: 'q1' }), t.ask({ question: 'q2' }), t.ask({ question: 'q3' })]);
    expect(outs.map((o) => o.reply)).toEqual(['reply from A', 'reply from A', 'reply from A']);
    expect(t.fa.calls.map((c) => c.newMessages.map((m) => m.body))).toEqual([['q1'], ['q2'], ['q3']]);
    await t.ask({ question: 'q4' });
    expect(t.fa.calls[3].newMessages.map((m) => m.body)).toEqual(['q4']);
  });

  it('lets a waiting ask abort promptly without disturbing the queue', async () => {
    const t = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    t.fa.handler = async () => {
      n++;
      if (n === 1) await gate;
      return { kind: 'reply', body: `r${n}`, harnessSessionId: 's' };
    };
    const p1 = t.ask({ question: 'q1' });
    const ctl = new AbortController();
    const p2 = t.failure(t.ask({ question: 'q2', signal: ctl.signal }));
    const p3 = t.ask({ question: 'q3' });
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    expect((await p2).code).toBe('aborted'); // resolves while ask 1 is still running
    expect(t.fa.calls).toHaveLength(1);
    release();
    expect((await p1).reply).toBe('r1');
    expect((await p3).reply).toBe('r2');
    expect(t.fa.calls).toHaveLength(2);
    // The aborted q2 was never answered; it stays in the conversation and is shown along with q3.
    expect(t.fa.calls[1].newMessages.map((m) => m.body)).toEqual(['q2', 'q3']);
  });

  it('scheduler.onMessage ignores messages of an ask conversation', async () => {
    vi.useFakeTimers();
    const t = make({ triage: true });
    t.triage.pickNames = 'ALL';
    const p = t.ask({});
    await vi.advanceTimersByTimeAsync(10);
    await p;
    const conv = t.askConvs()[0];
    for (const m of t.store.listMessages(conv.id)) t.scheduler.onMessage(m);
    t.scheduler.onMessage(t.store.addMessage({ conversationId: conv.id, senderId: t.human.id, body: 'x' }));
    const before = t.fa.calls.length + t.fb.calls.length;
    await t.settle();
    expect(t.fa.calls.length + t.fb.calls.length).toBe(before);
    expect(t.triage.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('validation', () => {
  it('rejects bad input with bad_request', async () => {
    const t = make();
    for (const o of [
      { as: 'nope' },
      { to: 'nobody' },
      { as: 'fake-a', to: 'A' },
      { to: '我' },
      { question: '   ' },
      { question: undefined },
      { question: 'x'.repeat(20001) },
    ]) {
      const e = await t.failure(t.ask(o));
      expect(e).toBeInstanceOf(AskError);
      expect(e.code).toBe('bad_request');
    }
    expect(t.askConvs()).toHaveLength(0);
    expect(t.fa.calls).toHaveLength(0);
  });

  it('resolves the target by adapter name too', async () => {
    const t = make();
    expect((await t.ask({ to: 'fake-a' })).reply).toBe('reply from A');
  });

  it('reports an unavailable answerer without creating anything', async () => {
    const t = make();
    t.unavailable.add('fake-a');
    const e = await t.failure(t.ask({}));
    expect(e.code).toBe('unavailable');
    expect(e.message).toContain('A 现在不可用：未登录');
    expect(t.askConvs()).toHaveLength(0);
    expect(t.store.maxSeq(t.dm.id)).toBe(0);
  });
});

describe('failure paths', () => {
  it('returns stopped when globally stopped', async () => {
    const t = make();
    t.scheduler.stopAll();
    expect((await t.failure(t.ask({}))).code).toBe('stopped');
    expect(t.fa.calls).toHaveLength(0);
    expect(t.askConvs()).toHaveLength(0);
    expect(t.store.listMessages(t.dm.id)).toHaveLength(0);
    expect(t.events.filter((e) => e.type === 'message' || e.type === 'conversation')).toHaveLength(0);
  });

  it('stopAll aborts an ask in progress', async () => {
    const t = make();
    t.fa.handler = hang;
    const p = t.failure(t.ask({}));
    await new Promise((r) => setTimeout(r, 20));
    t.scheduler.stopAll();
    expect((await p).code).toBe('aborted');
    expect(t.fa.calls[0].signal.aborted).toBe(true);
    const invs = t.store.listInvocations(t.askConvs()[0].id);
    expect(invs.map((i) => i.outcome)).toEqual(['interrupted']);
  });

  it('aborts the adapter and marks the invocation interrupted when the caller aborts', async () => {
    const t = make();
    t.fa.handler = hang;
    const ctl = new AbortController();
    const p = t.failure(t.ask({ signal: ctl.signal }));
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    expect((await p).code).toBe('aborted');
    expect(t.fa.calls[0].signal.aborted).toBe(true);
    const conv = t.askConvs()[0];
    expect(t.store.listInvocations(conv.id).map((i) => i.outcome)).toEqual(['interrupted']);
    expect(t.events.filter((e) => e.type === 'typing').map((e: any) => e.active)).toEqual([true, false]);
  });

  it('applies the daily cap to ask conversations', async () => {
    const t = make();
    const e1 = await t.ask({});
    expect(e1.reply).toBeTruthy();
    const conv = t.askConvs()[0];
    const normalBefore = t.store.listMessages(conv.id).filter((m) => m.kind === 'normal').length;
    t.store.updateSettings(conv.id, { dailyInvocationCap: 0 });
    const e = await t.failure(t.ask({}));
    expect(e.code).toBe('capped');
    expect(t.fa.calls).toHaveLength(1);
    expect(t.store.listMessages(conv.id).filter((m) => m.kind === 'normal')).toHaveLength(normalBefore);
    expect(t.store.listMessages(conv.id).filter((m) => m.kind === 'system')).toHaveLength(1);
  });

  it('maps an adapter timeout to timeout and leaves a system message', async () => {
    const t = make();
    t.fa.handler = async () => {
      throw new AdapterError('timeout', 'slow');
    };
    const e = await t.failure(t.ask({}));
    expect(e.code).toBe('timeout');
    const conv = t.askConvs()[0];
    const sys = t.store.listMessages(conv.id).filter((m) => m.kind === 'system');
    expect(sys).toHaveLength(1);
    expect(sys[0].body).toContain('超时');
    expect(sys[0].meta).not.toHaveProperty('retryable');
  });

  it('maps a crash to failed and keeps the stored session', async () => {
    const t = make();
    await t.ask({});
    t.fa.handler = async () => {
      throw new AdapterError('crashed', 'boom');
    };
    const e = await t.failure(t.ask({}));
    expect(e.code).toBe('failed');
    expect(e.message).toContain('boom');
    expect(t.store.getAgentSession(t.askConvs()[0].id, t.a.id)?.harnessSessionId).toBe('fake-a-session');
  });

  it('treats a silent answer as failed', async () => {
    const t = make();
    t.fa.handler = async () => ({ kind: 'silent', harnessSessionId: 's' });
    const e = await t.failure(t.ask({}));
    expect(e.code).toBe('failed');
    expect(e.message).toContain('没有给出回答');
  });

  it('refuses retrying an ask invocation through the round scheduler', async () => {
    const t = make();
    t.fa.handler = async () => {
      throw new AdapterError('timeout', 'slow');
    };
    await t.failure(t.ask({}));
    const conv = t.askConvs()[0];
    const sys = t.store.listMessages(conv.id).find((m) => m.kind === 'system')!;
    expect(await t.scheduler.retryInvocation(sys.meta!.invocationId as string)).toBe(false);
  });
});

describe('store migration', () => {
  it('opens a phase 1 database and supports findAskConversation', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'agentchat-mig-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE members (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        name TEXT NOT NULL UNIQUE, bio TEXT NOT NULL, adapter TEXT);
      CREATE TABLE conversations (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        title TEXT NOT NULL, settings TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE conversation_members (conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (conversation_id, member_id));
      INSERT INTO conversations (id, kind, title, settings, created_at) VALUES ('c1', 'dm', 'old', '{}', 1);
    `);
    old.close();
    const s = new Store(file);
    expect(s.getConversation('c1')?.title).toBe('old');
    expect(s.findAskConversation('x', 'y')).toBeNull();
    const c = s.createConversation({ kind: 'ask', title: 't', memberIds: ['x', 'y'], askFrom: 'x', askTo: 'y' });
    expect(s.findAskConversation('x', 'y')?.id).toBe(c.id);
    expect(s.findAskConversation('y', 'x')).toBeNull();
    expect(() => new Store(file)).not.toThrow();
  });
});

describe('a human message in an ask conversation', () => {
  it('is answered by the answerer in its existing session, which sees the human by name', async () => {
    const t = make();
    t.fa.handler = async () => ({ kind: 'reply', body: '第一答', harnessSessionId: 'sess-1' });
    await t.ask({ question: '第一问' });
    const conv = t.askConvs()[0];
    t.fa.handler = async () => ({ kind: 'reply', body: '收到', harnessSessionId: 'sess-1' });
    const m = t.store.addMessage({ conversationId: conv.id, senderId: t.human.id, body: '补充一句' });
    await t.scheduler.answerInAsk(m);
    expect(t.fa.calls[1].harnessSessionId).toBe('sess-1');
    expect(t.fa.calls[1].newMessages.map((x) => [x.senderName, x.body])).toEqual([['我', '补充一句']]);
    expect(t.store.listMessages(conv.id).at(-1)).toMatchObject({ senderId: t.a.id, body: '收到' });
    expect(t.store.listInvocations(conv.id).map((i) => i.reason)).toEqual(['ask', 'ask']);
  });

  it('ignores agent messages there', async () => {
    const t = make();
    await t.ask({});
    const conv = t.askConvs()[0];
    const m = t.store.addMessage({ conversationId: conv.id, senderId: t.b.id, body: '我自己说一句' });
    await t.scheduler.answerInAsk(m);
    expect(t.fa.calls).toHaveLength(1);
  });

  it('explains in a system message why nothing was answered when the hub is stopped', async () => {
    const t = make();
    await t.ask({});
    const conv = t.askConvs()[0];
    t.scheduler.stopAll();
    const m = t.store.addMessage({ conversationId: conv.id, senderId: t.human.id, body: '在吗' });
    await t.scheduler.answerInAsk(m);
    expect(t.fa.calls).toHaveLength(1);
    expect(t.store.listMessages(conv.id).at(-1)).toMatchObject({ kind: 'system', body: '已全局停止，这条消息没有被处理。' });
  });

  it('explains a silent answerer', async () => {
    const t = make();
    await t.ask({});
    const conv = t.askConvs()[0];
    t.fa.handler = async () => ({ kind: 'silent', harnessSessionId: 's' });
    const m = t.store.addMessage({ conversationId: conv.id, senderId: t.human.id, body: '在吗' });
    await t.scheduler.answerInAsk(m);
    expect(t.store.listMessages(conv.id).at(-1)).toMatchObject({ kind: 'system', body: 'A 没有回答。' });
  });
});
