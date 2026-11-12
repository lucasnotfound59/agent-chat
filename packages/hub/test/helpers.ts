import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { FakeAdapter } from '@agent-chat/adapters';
import { Scheduler } from '../src/scheduler';
import { Store } from '../src/store';
import type { Triage, TriageInput } from '../src/triage';
import type { HubEvent, Settings } from '../src/types';

export class FakeTriage implements Triage {
  calls: TriageInput[] = [];
  /** Names to pick; 'ALL' picks every candidate in order. */
  pickNames: string[] | 'ALL' = [];
  fail = false;
  async pick(input: TriageInput): Promise<string[]> {
    this.calls.push(input);
    if (this.fail) throw new Error('triage down');
    if (this.pickNames === 'ALL') return input.candidates.map((c) => c.id);
    return this.pickNames
      .map((n) => input.candidates.find((c) => c.name === n)?.id)
      .filter((x): x is string => Boolean(x));
  }
}

export function setup(
  opts: { triage?: boolean | Triage; settings?: Partial<Settings>; onEmit?: (e: HubEvent) => void } = {},
) {
  const store = new Store(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'agentchat-test-'));
  const fa = new FakeAdapter('fake-a', 'A');
  const fb = new FakeAdapter('fake-b', 'B');
  const human = store.createMember({ kind: 'human', name: '我' });
  const a = store.createMember({ kind: 'agent', name: 'A', bio: 'agent a', adapter: 'fake-a' });
  const b = store.createMember({ kind: 'agent', name: 'B', bio: 'agent b', adapter: 'fake-b' });
  const dm = store.createConversation({ kind: 'dm', title: 'A', memberIds: [human.id, a.id] });
  const group = store.createConversation({
    kind: 'group',
    title: 'G',
    memberIds: [human.id, a.id, b.id],
    settings: opts.settings,
  });
  const triage = new FakeTriage();
  const events: HubEvent[] = [];
  const unavailable = new Set<string>();
  const scheduler = new Scheduler({
    store,
    adapters: new Map([
      [fa.name, fa],
      [fb.name, fb],
    ]),
    triage: () => (opts.triage === true ? triage : opts.triage || null),
    emit: (e) => {
      events.push(e);
      opts.onEmit?.(e);
    },
    dataDir,
    isAvailable: (name) => !unavailable.has(name),
  });
  /** Stores a human message and notifies the scheduler, like the HTTP layer does. */
  const say = (conversationId: string, body: string, mentions: string[] = []) => {
    const m = store.addMessage({ conversationId, senderId: human.id, body, mentions });
    scheduler.onMessage(m);
    return m;
  };
  /** Runs timers until every chained round has finished. */
  const settle = async () => {
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(3000);
  };
  const bodies = (conversationId: string) => store.listMessages(conversationId, { limit: 500 }).map((m) => m.body);
  return { store, dataDir, fa, fb, human, a, b, dm, group, triage, events, unavailable, scheduler, say, settle, bodies };
}
