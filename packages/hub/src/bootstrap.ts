import type { AgentAdapter } from '@agent-chat/adapters';
import type { Store } from './store';

/**
 * Idempotent and incremental: creates the human if missing, and for each adapter without a member
 * creates the agent member and its private chat. Existing members and conversations are untouched.
 */
export function seed(store: Store, adapters: AgentAdapter[]): void {
  const me = store.listMembers().find((m) => m.kind === 'human') ?? store.createMember({ kind: 'human', name: '我' });
  for (const adapter of adapters) {
    if (store.listMembers().some((m) => m.adapter === adapter.name)) continue;
    const taken = new Set(store.listMembers().map((m) => m.name));
    let name = adapter.displayName;
    for (let n = 2; taken.has(name); n++) name = `${adapter.displayName} ${n}`;
    const agent = store.createMember({ kind: 'agent', name, bio: adapter.defaultBio, adapter: adapter.name });
    store.createConversation({ kind: 'dm', title: name, memberIds: [me.id, agent.id] });
  }
}
