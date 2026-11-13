import type { Conversation, HubEvent, Member, MemberView, Message, StateResponse } from './types';

export type Connection = 'connecting' | 'open' | 'closed' | 'unauthorized' | 'hub_down';
export const PAGE = 50;

export interface ChatState {
  me: Member | null;
  members: MemberView[];
  conversations: Conversation[];
  lastMessage: Record<string, Message | null>;
  /** Messages loaded so far per conversation, ascending by seq; absent until the conversation is opened. */
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  typing: Record<string, string[]>;
  stopped: boolean;
  connection: Connection;
}

export const initialState: ChatState = {
  me: null,
  members: [],
  conversations: [],
  lastMessage: {},
  messages: {},
  hasMore: {},
  typing: {},
  stopped: false,
  connection: 'connecting',
};

export type Action =
  | { type: 'state'; state: StateResponse }
  | { type: 'messages'; conversationId: string; messages: Message[]; older: boolean }
  | { type: 'event'; event: HubEvent }
  | { type: 'connection'; connection: Connection };

export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

const newer = (a: Message | null | undefined, b: Message): Message => (!a || b.seq > a.seq ? b : a);

export function reduce(s: ChatState, a: Action): ChatState {
  switch (a.type) {
    case 'state': {
      const lastMessage: Record<string, Message | null> = {};
      for (const c of a.state.conversations) {
        const prev = s.lastMessage[c.id] ?? null;
        lastMessage[c.id] = c.lastMessage ? newer(prev, c.lastMessage) : prev;
      }
      const conversations = a.state.conversations.map(({ lastMessage: _drop, ...c }) => c);
      return { ...s, me: a.state.me, members: a.state.members, conversations, lastMessage, stopped: a.state.stopped };
    }
    case 'messages': {
      const id = a.conversationId;
      const merged = mergeMessages(s.messages[id] ?? [], a.messages);
      const hasMore = a.older || !(id in s.hasMore) ? a.messages.length >= PAGE : s.hasMore[id];
      const last = merged.at(-1);
      return {
        ...s,
        messages: { ...s.messages, [id]: merged },
        hasMore: { ...s.hasMore, [id]: hasMore },
        lastMessage: last ? { ...s.lastMessage, [id]: newer(s.lastMessage[id], last) } : s.lastMessage,
      };
    }
    case 'connection':
      return { ...s, connection: a.connection };
    case 'event':
      return applyEvent(s, a.event);
  }
}

function applyEvent(s: ChatState, e: HubEvent): ChatState {
  switch (e.type) {
    case 'message': {
      const id = e.message.conversationId;
      const loaded = s.messages[id];
      return {
        ...s,
        messages: loaded ? { ...s.messages, [id]: mergeMessages(loaded, [e.message]) } : s.messages,
        lastMessage: { ...s.lastMessage, [id]: newer(s.lastMessage[id], e.message) },
      };
    }
    case 'typing': {
      const cur = s.typing[e.conversationId] ?? [];
      const next = e.active ? (cur.includes(e.memberId) ? cur : [...cur, e.memberId]) : cur.filter((m) => m !== e.memberId);
      return { ...s, typing: { ...s.typing, [e.conversationId]: next } };
    }
    case 'conversation': {
      const exists = s.conversations.some((c) => c.id === e.conversation.id);
      const conversations = exists
        ? s.conversations.map((c) => (c.id === e.conversation.id ? e.conversation : c))
        : [...s.conversations, e.conversation];
      return { ...s, conversations };
    }
    case 'stopped':
      return { ...s, stopped: e.stopped };
    case 'availability':
      return { ...s, members: s.members.map((m) => (m.adapter === e.adapter ? { ...m, availability: e.availability } : m)) };
  }
}

const activity = (s: ChatState, c: Conversation) => s.lastMessage[c.id]?.createdAt ?? c.createdAt;

export function sidebarGroups(s: ChatState): { groups: Conversation[]; dms: Conversation[]; asks: Conversation[] } {
  const of = (kind: Conversation['kind']) => s.conversations.filter((c) => c.kind === kind);
  const recent = (list: Conversation[]) => [...list].sort((x, y) => activity(s, y) - activity(s, x));
  return { groups: recent(of('group')), dms: of('dm'), asks: recent(of('ask')) };
}

export function dmAgent(s: ChatState, c: Conversation): MemberView | undefined {
  return s.members.find((m) => m.kind === 'agent' && c.memberIds.includes(m.id));
}
