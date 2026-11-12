export type MemberKind = 'human' | 'agent';

export interface Member {
  id: string;
  kind: MemberKind;
  name: string;
  bio: string;
  adapter: string | null;
}

export interface Settings {
  debounceMs: number;
  maxAgentRounds: number;
  dailyInvocationCap: number;
  timeoutMs: number;
  paused: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  debounceMs: 3000,
  maxAgentRounds: 6,
  dailyInvocationCap: 200,
  timeoutMs: 300000,
  paused: false,
};

export interface Conversation {
  id: string;
  kind: 'dm' | 'group' | 'ask';
  title: string;
  settings: Settings;
  memberIds: string[];
  createdAt: number;
}

export interface Attachment {
  name: string;
  /** Path relative to <dataDir>/attachments. */
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

export type Outcome = 'replied' | 'silent' | 'timeout' | 'error' | 'interrupted';

export interface Invocation {
  id: string;
  conversationId: string;
  memberId: string;
  reason: string;
  startedAt: number;
  endedAt: number | null;
  outcome: Outcome | null;
}

export type HubEvent =
  | { type: 'message'; message: Message }
  | { type: 'typing'; conversationId: string; memberId: string; active: boolean }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'stopped'; stopped: boolean };
