// Mirrors packages/hub/src/types.ts (keep in sync) plus the shapes the hub's HTTP API adds.
export interface Availability {
  ok: boolean;
  reason?: string;
}

export interface Member {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  bio: string;
  adapter: string | null;
}

/** A member as /api/state returns it. */
export type MemberView = Member & { availability: Availability | null };

export interface Settings {
  debounceMs: number;
  maxAgentRounds: number;
  dailyInvocationCap: number;
  timeoutMs: number;
  paused: boolean;
}

export interface Conversation {
  id: string;
  kind: 'dm' | 'group' | 'ask';
  title: string;
  settings: Settings;
  memberIds: string[];
  createdAt: number;
}

export type ConversationView = Conversation & { lastMessage: Message | null };

export interface Attachment {
  name: string;
  file: string;
}

export interface Message {
  id: string;
  seq: number;
  conversationId: string;
  senderId: string | null;
  kind: 'normal' | 'system';
  body: string;
  mentions: string[];
  replyTo: string | null;
  attachments: Attachment[];
  meta: Record<string, unknown> | null;
  createdAt: number;
}

export type HubEvent =
  | { type: 'message'; message: Message }
  | { type: 'typing'; conversationId: string; memberId: string; active: boolean }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'stopped'; stopped: boolean }
  | { type: 'availability'; adapter: string; availability: Availability };

export interface StateResponse {
  me: Member;
  members: MemberView[];
  conversations: ConversationView[];
  stopped: boolean;
}
