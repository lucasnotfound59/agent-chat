import { describe, expect, it } from 'vitest';
import { FakeAdapter } from '@agent-chat/adapters';
import { seed } from '../src/bootstrap';
import { Store } from '../src/store';

describe('seed (incremental)', () => {
  it('seeding twice with the same adapters changes nothing', () => {
    const store = new Store(':memory:');
    const list = [new FakeAdapter('fa', 'A'), new FakeAdapter('fb', 'B')];
    seed(store, list);
    seed(store, list);
    expect(store.listMembers()).toHaveLength(3);
    expect(store.listConversations()).toHaveLength(2);
  });

  it('adds exactly one member and one private chat for a newly introduced adapter', () => {
    const store = new Store(':memory:');
    const a = new FakeAdapter('fa', 'A');
    const b = new FakeAdapter('fb', 'B');
    seed(store, [a, b]);
    const before = store.listConversations().map((c) => c.id);
    seed(store, [a, b, new FakeAdapter('fc', 'C')]);
    expect(store.listMembers().map((m) => m.name)).toEqual(['我', 'A', 'B', 'C']);
    const convs = store.listConversations();
    expect(convs).toHaveLength(3);
    expect(convs.slice(0, 2).map((c) => c.id)).toEqual(before);
    const c = convs.find((x) => x.title === 'C')!;
    expect(c.kind).toBe('dm');
    expect(store.listConversationMembers(c.id).map((m) => m.name).sort()).toEqual(['C', '我']);
  });

  it('suffixes the name when a new adapter display name collides', () => {
    const store = new Store(':memory:');
    seed(store, [new FakeAdapter('fa', 'A')]);
    seed(store, [new FakeAdapter('fa', 'A'), new FakeAdapter('fx', 'A'), new FakeAdapter('fy', 'A')]);
    expect(store.listMembers().map((m) => m.name)).toEqual(['我', 'A', 'A 2', 'A 3']);
    expect(store.listConversations().map((c) => c.title)).toEqual(['A', 'A 2', 'A 3']);
  });
});
