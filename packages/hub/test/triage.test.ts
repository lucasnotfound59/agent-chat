import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from '@agent-chat/adapters';
import type { AgentAdapter } from '@agent-chat/adapters';
import { setup } from './helpers';
import { parseMentions } from '../src/mentions';
import { AgentTriage, TRIAGE_ORDER, parseSpeakers, pickTriageAdapter } from '../src/triage';
import type { Member } from '../src/types';

const members: Member[] = [
  { id: 'h', kind: 'human', name: '我', bio: '', adapter: null },
  { id: 'a', kind: 'agent', name: 'Claude Code', bio: '', adapter: 'claude' },
  { id: 'b', kind: 'agent', name: 'Codex', bio: '', adapter: 'codex' },
];
const candidates = [
  { id: 'a', name: 'Claude Code', bio: 'x' },
  { id: 'b', name: 'Codex', bio: 'y' },
];

describe('parseMentions', () => {
  it('finds @Name for members, including names with spaces', () => {
    expect(parseMentions('@Claude Code 和 @Codex 看一下', members, 'h')).toEqual(['a', 'b']);
  });
  it('ignores self-mentions and unknown names', () => {
    expect(parseMentions('@Codex @Nobody', members, 'b')).toEqual([]);
  });
});

describe('parseSpeakers', () => {
  it('maps names to ids, keeps order, drops unknowns and duplicates', () => {
    expect(parseSpeakers('{"speakers":["Codex","Ghost","Claude Code","Codex"]}', candidates)).toEqual(['b', 'a']);
  });
  it('returns empty for a missing list', () => {
    expect(parseSpeakers('{}', candidates)).toEqual([]);
  });
  it('throws on invalid JSON', () => {
    expect(() => parseSpeakers('nope', candidates)).toThrow();
  });
});

describe('pickTriageAdapter', () => {
  const names = ['claude', 'codex', 'opencode', 'dsh'];
  const adapters = new Map<string, AgentAdapter>(names.map((n) => [n, new FakeAdapter(n, n)]));
  const all = () => true;

  it('has the documented automatic order', () => {
    expect([...TRIAGE_ORDER]).toEqual(['dsh', 'opencode', 'codex', 'claude']);
  });
  it('returns null when switched off', () => {
    expect(pickTriageAdapter('off', adapters, all)).toBeNull();
  });
  it('returns the chosen adapter when it is available', () => {
    expect(pickTriageAdapter('codex', adapters, all)?.name).toBe('codex');
  });
  it('returns null when the chosen adapter is unavailable or unknown', () => {
    expect(pickTriageAdapter('codex', adapters, (n) => n !== 'codex')).toBeNull();
    expect(pickTriageAdapter('nope', adapters, all)).toBeNull();
  });
  it('picks the first available in order when automatic', () => {
    expect(pickTriageAdapter(null, adapters, all)?.name).toBe('dsh');
    expect(pickTriageAdapter(null, adapters, (n) => n === 'codex' || n === 'claude')?.name).toBe('codex');
  });
  it('returns null when nothing is available', () => {
    expect(pickTriageAdapter(null, adapters, () => false)).toBeNull();
    expect(pickTriageAdapter(null, new Map(), all)).toBeNull();
  });
});

describe('AgentTriage', () => {
  const input = { transcript: [{ sender: '我', body: '谁懂 Rust？' }], candidates };
  const make = (reply: string | Error) => {
    const fake = new FakeAdapter('fake-t', 'T');
    fake.completeHandler = async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    };
    return { fake, triage: new AgentTriage(fake, '/tmp/triage-workdir') };
  };

  it('asks the adapter with candidates and transcript and parses fenced JSON', async () => {
    const { fake, triage } = make('好的：\n```json\n{"speakers":["Codex"]}\n```');
    expect(await triage.pick(input)).toEqual(['b']);
    const req = fake.completeCalls[0];
    expect(req.workdir).toBe('/tmp/triage-workdir');
    expect(req.timeoutMs).toBe(60000);
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect(req.prompt).toContain('Claude Code: x');
    expect(req.prompt).toContain('Codex: y');
    expect(req.prompt).toContain('我: 谁懂 Rust？');
    expect(req.prompt).toContain('{"speakers"');
  });
  it('uses a custom timeout', async () => {
    const fake = new FakeAdapter('fake-t', 'T');
    await new AgentTriage(fake, '/w', 1234).pick(input);
    expect(fake.completeCalls[0].timeoutMs).toBe(1234);
  });
  it('throws when the reply has no JSON object', async () => {
    await expect(make('没有人需要回答').triage.pick(input)).rejects.toThrow();
  });
  it('propagates errors from complete()', async () => {
    await expect(make(new Error('boom')).triage.pick(input)).rejects.toThrow('boom');
  });
});

describe('scheduler with AgentTriage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('wakes the agent the triage adapter picks when nobody is mentioned', async () => {
    const tf = new FakeAdapter('fake-t', 'T');
    tf.completeHandler = async () => (tf.completeCalls.length === 1 ? '{"speakers":["A"]}' : '{"speakers":[]}');
    const t = setup({ triage: new AgentTriage(tf, '/w') });
    t.say(t.group.id, '大家怎么看');
    await t.settle();
    expect(tf.completeCalls.length).toBeGreaterThanOrEqual(1);
    expect(t.fa.calls).toHaveLength(1);
    expect(t.fb.calls).toHaveLength(0);
  });
});
