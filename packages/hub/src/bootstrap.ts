import type { AgentAdapter } from '@agent-chat/adapters';
import type { Store } from './store';

/** Creates the human, one agent member per adapter, and their private chats on first run. */
export function seed(store: Store, adapters: AgentAdapter[]): void {
  if (store.listMembers().length > 0) return;
  const me = store.createMember({ kind: 'human', name: '我' });
  for (const adapter of adapters) {
    const agent = store.createMember({
      kind: 'agent',
      name: adapter.displayName,
      bio: adapter.defaultBio,
      adapter: adapter.name,
    });
    store.createConversation({ kind: 'dm', title: adapter.displayName, memberIds: [me.id, agent.id] });
  }
}
