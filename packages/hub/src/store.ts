import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS } from './types';
import type { Attachment, Conversation, Invocation, Member, MemberKind, Message, Outcome, Settings } from './types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE, bio TEXT NOT NULL, adapter TEXT);
CREATE TABLE IF NOT EXISTS conversations (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, title TEXT NOT NULL,
  settings TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (conversation_id, member_id));
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
  sender_id TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, mentions TEXT NOT NULL, reply_to TEXT,
  attachments TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, seq);
CREATE TABLE IF NOT EXISTS agent_sessions (
  conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, harness_session_id TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL, PRIMARY KEY (conversation_id, member_id));
CREATE TABLE IF NOT EXISTS invocations (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, reason TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT);
`;

type Row = Record<string, any>;

const toMember = (r: Row): Member => ({ id: r.id, kind: r.kind, name: r.name, bio: r.bio, adapter: r.adapter ?? null });

const toMessage = (r: Row): Message => ({
  id: r.id,
  seq: Number(r.seq),
  conversationId: r.conversation_id,
  senderId: r.sender_id ?? null,
  kind: r.kind,
  body: r.body,
  mentions: JSON.parse(r.mentions),
  replyTo: r.reply_to ?? null,
  attachments: JSON.parse(r.attachments),
  meta: r.meta ? JSON.parse(r.meta) : null,
  createdAt: Number(r.created_at),
});

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // Phase 1 databases lack the ask columns.
    const cols = this.db.prepare('PRAGMA table_info(conversations)').all().map((c: Row) => c.name as string);
    for (const col of ['ask_from', 'ask_to']) {
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE conversations ADD COLUMN ${col} TEXT`);
    }
  }

  createMember(input: { kind: MemberKind; name: string; bio?: string; adapter?: string | null }): Member {
    const m: Member = {
      id: randomUUID(),
      kind: input.kind,
      name: input.name,
      bio: input.bio ?? '',
      adapter: input.adapter ?? null,
    };
    this.db
      .prepare('INSERT INTO members (id, kind, name, bio, adapter) VALUES (?, ?, ?, ?, ?)')
      .run(m.id, m.kind, m.name, m.bio, m.adapter);
    return m;
  }

  listMembers(): Member[] {
    return this.db.prepare('SELECT * FROM members ORDER BY rowid').all().map(toMember);
  }

  getMember(id: string): Member | null {
    const r = this.db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    return r ? toMember(r) : null;
  }

  updateMemberBio(id: string, bio: string): void {
    this.db.prepare('UPDATE members SET bio = ? WHERE id = ?').run(bio, id);
  }

  createConversation(input: {
    kind: 'dm' | 'group' | 'ask';
    title: string;
    memberIds: string[];
    settings?: Partial<Settings>;
    askFrom?: string;
    askTo?: string;
  }): Conversation {
    const c: Conversation = {
      id: randomUUID(),
      kind: input.kind,
      title: input.title,
      settings: { ...DEFAULT_SETTINGS, ...input.settings },
      memberIds: [...new Set(input.memberIds)],
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO conversations (id, kind, title, settings, created_at, ask_from, ask_to) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(c.id, c.kind, c.title, JSON.stringify(c.settings), c.createdAt, input.askFrom ?? null, input.askTo ?? null);
    const add = this.db.prepare('INSERT INTO conversation_members (conversation_id, member_id) VALUES (?, ?)');
    for (const id of c.memberIds) add.run(c.id, id);
    return c;
  }

  private toConversation(r: Row): Conversation {
    const memberIds = this.db
      .prepare('SELECT member_id FROM conversation_members WHERE conversation_id = ?')
      .all(r.id)
      .map((x: Row) => x.member_id as string);
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      settings: { ...DEFAULT_SETTINGS, ...JSON.parse(r.settings) },
      memberIds,
      createdAt: Number(r.created_at),
    };
  }

  listConversations(): Conversation[] {
    return this.db
      .prepare('SELECT * FROM conversations ORDER BY rowid')
      .all()
      .map((r: Row) => this.toConversation(r));
  }

  getConversation(id: string): Conversation | null {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    return r ? this.toConversation(r) : null;
  }

  findAskConversation(askerId: string, targetId: string): Conversation | null {
    const r = this.db
      .prepare("SELECT * FROM conversations WHERE kind = 'ask' AND ask_from = ? AND ask_to = ? ORDER BY rowid LIMIT 1")
      .get(askerId, targetId);
    return r ? this.toConversation(r) : null;
  }

  updateSettings(id: string, patch: Partial<Settings>): Conversation {
    const c = this.getConversation(id);
    if (!c) throw new Error(`unknown conversation ${id}`);
    const settings = { ...c.settings, ...patch };
    this.db.prepare('UPDATE conversations SET settings = ? WHERE id = ?').run(JSON.stringify(settings), id);
    return { ...c, settings };
  }

  listConversationMembers(id: string): Member[] {
    return this.db
      .prepare(
        'SELECT m.* FROM members m JOIN conversation_members cm ON cm.member_id = m.id WHERE cm.conversation_id = ? ORDER BY m.rowid',
      )
      .all(id)
      .map(toMember);
  }

  addMessage(input: {
    conversationId: string;
    senderId: string | null;
    kind?: 'normal' | 'system';
    body: string;
    mentions?: string[];
    replyTo?: string | null;
    attachments?: Attachment[];
    meta?: Record<string, unknown> | null;
  }): Message {
    const id = randomUUID();
    const createdAt = Date.now();
    const info = this.db
      .prepare(
        'INSERT INTO messages (id, conversation_id, sender_id, kind, body, mentions, reply_to, attachments, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.conversationId,
        input.senderId,
        input.kind ?? 'normal',
        input.body,
        JSON.stringify(input.mentions ?? []),
        input.replyTo ?? null,
        JSON.stringify(input.attachments ?? []),
        input.meta ? JSON.stringify(input.meta) : null,
        createdAt,
      );
    return {
      id,
      seq: Number(info.lastInsertRowid),
      conversationId: input.conversationId,
      senderId: input.senderId,
      kind: input.kind ?? 'normal',
      body: input.body,
      mentions: input.mentions ?? [],
      replyTo: input.replyTo ?? null,
      attachments: input.attachments ?? [],
      meta: input.meta ?? null,
      createdAt,
    };
  }

  listMessages(conversationId: string, opts: { beforeSeq?: number; limit?: number } = {}): Message[] {
    const limit = opts.limit ?? 50;
    const before = opts.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
      .all(conversationId, before, limit)
      .map(toMessage)
      .reverse();
  }

  listMessagesAfter(conversationId: string, seq: number): Message[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq')
      .all(conversationId, seq)
      .map(toMessage);
  }

  maxSeq(conversationId: string): number {
    const r = this.db.prepare('SELECT MAX(seq) AS s FROM messages WHERE conversation_id = ?').get(conversationId);
    return Number(r?.s ?? 0);
  }

  getAgentSession(conversationId: string, memberId: string): { harnessSessionId: string; lastSeenSeq: number } | null {
    const r = this.db
      .prepare('SELECT * FROM agent_sessions WHERE conversation_id = ? AND member_id = ?')
      .get(conversationId, memberId);
    return r ? { harnessSessionId: r.harness_session_id as string, lastSeenSeq: Number(r.last_seen_seq) } : null;
  }

  setAgentSession(conversationId: string, memberId: string, harnessSessionId: string, lastSeenSeq: number): void {
    this.db
      .prepare(
        'INSERT INTO agent_sessions (conversation_id, member_id, harness_session_id, last_seen_seq) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (conversation_id, member_id) DO UPDATE SET harness_session_id = excluded.harness_session_id, last_seen_seq = excluded.last_seen_seq',
      )
      .run(conversationId, memberId, harnessSessionId, lastSeenSeq);
  }

  clearAgentSession(conversationId: string, memberId: string): void {
    this.db
      .prepare('DELETE FROM agent_sessions WHERE conversation_id = ? AND member_id = ?')
      .run(conversationId, memberId);
  }

  startInvocation(conversationId: string, memberId: string, reason: string): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO invocations (id, conversation_id, member_id, reason, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, conversationId, memberId, reason, Date.now());
    return id;
  }

  finishInvocation(id: string, outcome: Outcome): void {
    this.db.prepare('UPDATE invocations SET ended_at = ?, outcome = ? WHERE id = ?').run(Date.now(), outcome, id);
  }

  getInvocation(id: string): Invocation | null {
    const r = this.db.prepare('SELECT * FROM invocations WHERE id = ?').get(id);
    if (!r) return null;
    return {
      id: r.id as string,
      conversationId: r.conversation_id as string,
      memberId: r.member_id as string,
      reason: r.reason as string,
      startedAt: Number(r.started_at),
      endedAt: r.ended_at == null ? null : Number(r.ended_at),
      outcome: (r.outcome as Outcome | null) ?? null,
    };
  }

  countInvocationsSince(conversationId: string, sinceMs: number): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM invocations WHERE conversation_id = ? AND started_at >= ?')
      .get(conversationId, sinceMs);
    return Number(r?.n ?? 0);
  }

  markUnfinishedInterrupted(): number {
    const info = this.db
      .prepare("UPDATE invocations SET ended_at = ?, outcome = 'interrupted' WHERE outcome IS NULL")
      .run(Date.now());
    return Number(info.changes);
  }
}
