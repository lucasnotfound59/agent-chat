import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { AdapterError } from '@agent-chat/adapters';
import type { AgentAdapter, InvokeRequest, InvokeResult } from '@agent-chat/adapters';
import { parseMentions } from './mentions';
import type { Store } from './store';
import type { Triage } from './triage';
import type { Conversation, HubEvent, Member, Message } from './types';

const HISTORY_REPLAY = 30;
const MAX_NEW_MESSAGES = 50;
const TRIAGE_TRANSCRIPT = 20;

export interface SchedulerDeps {
  store: Store;
  adapters: Map<string, AgentAdapter>;
  triage: () => Triage | null;
  emit: (e: HubEvent) => void;
  dataDir: string;
  isAvailable: (adapterName: string) => boolean;
}

interface ConvState {
  timer: NodeJS.Timeout | null;
  running: boolean;
  /** Consecutive rounds triggered without any human message. */
  agentRounds: number;
  lastProcessedSeq: number;
  abort: AbortController | null;
  capNoticeDay: string | null;
}

type Session = { harnessSessionId: string; lastSeenSeq: number };

export class Scheduler {
  private readonly states = new Map<string, ConvState>();
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  isStopped(): boolean {
    return this.stopped;
  }

  onMessage(msg: Message): void {
    if (msg.kind !== 'normal') return;
    const st = this.state(msg.conversationId, msg.seq - 1);
    const sender = msg.senderId ? this.deps.store.getMember(msg.senderId) : null;
    if (sender?.kind === 'human') st.agentRounds = 0;
    if (st.running) return;
    this.schedule(msg.conversationId);
  }

  kick(conversationId: string): void {
    const st = this.state(conversationId);
    if (!st.running) this.schedule(conversationId);
  }

  abortConversation(conversationId: string): void {
    const st = this.states.get(conversationId);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    st.abort?.abort();
  }

  stopAll(): void {
    this.stopped = true;
    for (const id of this.states.keys()) this.abortConversation(id);
    this.deps.emit({ type: 'stopped', stopped: true });
  }

  resumeAll(): void {
    this.stopped = false;
    this.deps.emit({ type: 'stopped', stopped: false });
    for (const c of this.deps.store.listConversations()) this.kick(c.id);
  }

  async retryInvocation(invocationId: string): Promise<boolean> {
    const inv = this.deps.store.getInvocation(invocationId);
    if (!inv || this.stopped) return false;
    const conv = this.deps.store.getConversation(inv.conversationId);
    const agent = this.deps.store.getMember(inv.memberId);
    if (!conv || !agent || conv.settings.paused) return false;
    const st = this.state(conv.id);
    if (st.running) return false;
    st.running = true;
    st.abort = new AbortController();
    try {
      await this.invokeAgent(conv, agent, 'retry', st.abort.signal);
    } finally {
      this.endRun(conv.id, st);
    }
    return true;
  }

  private state(conversationId: string, initialSeq?: number): ConvState {
    let st = this.states.get(conversationId);
    if (!st) {
      st = {
        timer: null,
        running: false,
        agentRounds: 0,
        lastProcessedSeq: initialSeq ?? this.deps.store.maxSeq(conversationId),
        abort: null,
        capNoticeDay: null,
      };
      this.states.set(conversationId, st);
    }
    return st;
  }

  private schedule(conversationId: string): void {
    const conv = this.deps.store.getConversation(conversationId);
    if (!conv) return;
    const st = this.state(conversationId);
    if (st.timer) clearTimeout(st.timer);
    const delay = conv.kind === 'dm' ? 0 : conv.settings.debounceMs;
    st.timer = setTimeout(() => {
      st.timer = null;
      this.runRound(conversationId).catch((err) => {
        console.error('[scheduler] round failed', err);
      });
    }, delay);
  }

  private endRun(conversationId: string, st: ConvState): void {
    st.running = false;
    st.abort = null;
    if (!this.stopped && this.deps.store.maxSeq(conversationId) > st.lastProcessedSeq) this.schedule(conversationId);
  }

  private async runRound(conversationId: string): Promise<void> {
    const { store } = this.deps;
    const st = this.state(conversationId);
    if (st.running || this.stopped) return;
    const conv = store.getConversation(conversationId);
    if (!conv || conv.settings.paused) return;
    const pending = store.listMessagesAfter(conversationId, st.lastProcessedSeq);
    const triggers = pending.filter((m) => m.kind === 'normal');
    if (pending.length > 0) st.lastProcessedSeq = pending[pending.length - 1].seq;
    if (triggers.length === 0) return;

    st.running = true;
    st.abort = new AbortController();
    const signal = st.abort.signal;
    try {
      const members = store.listConversationMembers(conversationId);
      const humanIds = new Set(members.filter((m) => m.kind === 'human').map((m) => m.id));
      const hasHuman = triggers.some((m) => m.senderId !== null && humanIds.has(m.senderId));
      if (!hasHuman) {
        if (st.agentRounds >= conv.settings.maxAgentRounds) return;
        st.agentRounds++;
      }
      const speakers = await this.pickSpeakers(conv, members, triggers);
      for (const agent of speakers) {
        if (signal.aborted || this.stopped) break;
        const current = store.getConversation(conversationId);
        if (!current || current.settings.paused) break;
        if (!this.underDailyCap(current, st)) break;
        const completed = await this.invokeAgent(current, agent, 'round', signal);
        if (!completed) break;
      }
    } finally {
      this.endRun(conversationId, st);
    }
  }

  private async pickSpeakers(conv: Conversation, members: Member[], triggers: Message[]): Promise<Member[]> {
    const agents = members.filter((m) => m.kind === 'agent' && m.adapter !== null && this.deps.isAvailable(m.adapter));
    // An agent never answers a round made up only of its own messages.
    const eligible = agents.filter((a) => !triggers.every((t) => t.senderId === a.id));
    if (conv.kind === 'dm') return eligible;

    const mentioned: Member[] = [];
    for (const t of triggers) {
      for (const id of t.mentions) {
        const a = eligible.find((x) => x.id === id);
        if (a && a.id !== t.senderId && !mentioned.includes(a)) mentioned.push(a);
      }
    }
    const rest = eligible.filter((a) => !mentioned.includes(a));
    const triage = this.deps.triage();
    if (!triage || rest.length === 0) return mentioned;

    const nameOf = (id: string | null) => members.find((m) => m.id === id)?.name ?? '系统';
    const transcript = this.deps.store
      .listMessages(conv.id, { limit: TRIAGE_TRANSCRIPT })
      .filter((m) => m.kind === 'normal')
      .map((m) => ({ sender: nameOf(m.senderId), body: m.body }));
    let picked: Member[] = [];
    try {
      const ids = await triage.pick({
        transcript,
        candidates: rest.map((a) => ({ id: a.id, name: a.name, bio: a.bio })),
      });
      for (const id of ids) {
        const a = rest.find((x) => x.id === id);
        if (a && !picked.includes(a)) picked.push(a);
      }
    } catch {
      picked = [];
    }
    return [...mentioned, ...picked];
  }

  private underDailyCap(conv: Conversation, st: ConvState): boolean {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const used = this.deps.store.countInvocationsSince(conv.id, dayStart.getTime());
    if (used < conv.settings.dailyInvocationCap) return true;
    const day = dayStart.toDateString();
    if (st.capNoticeDay !== day) {
      st.capNoticeDay = day;
      this.system(conv.id, `今日唤起次数已达上限（${conv.settings.dailyInvocationCap}），agent 暂停发言。`);
    }
    return false;
  }

  /** Returns false when the invocation was aborted and the round should stop. */
  private async invokeAgent(conv: Conversation, agent: Member, reason: string, signal: AbortSignal): Promise<boolean> {
    const { store, emit } = this.deps;
    const adapter = agent.adapter ? this.deps.adapters.get(agent.adapter) : undefined;
    if (!adapter) return true;
    const invocationId = store.startInvocation(conv.id, agent.id, reason);
    try {
      emit({ type: 'typing', conversationId: conv.id, memberId: agent.id, active: true });
      const { result, seenSeq } = await this.callAdapter(adapter, conv, agent, signal);
      store.setAgentSession(conv.id, agent.id, result.harnessSessionId, seenSeq);
      if (result.kind === 'reply') {
        const members = store.listConversationMembers(conv.id);
        const message = store.addMessage({
          conversationId: conv.id,
          senderId: agent.id,
          body: result.body,
          mentions: parseMentions(result.body, members, agent.id),
        });
        emit({ type: 'message', message });
        store.finishInvocation(invocationId, 'replied');
      } else {
        store.finishInvocation(invocationId, 'silent');
      }
      return true;
    } catch (e) {
      const code = e instanceof AdapterError ? e.code : 'crashed';
      if (code === 'aborted') {
        store.finishInvocation(invocationId, 'interrupted');
        return false;
      }
      if (code === 'timeout') {
        store.finishInvocation(invocationId, 'timeout');
        this.system(conv.id, `${agent.name} 没有回应（超时）。`, { invocationId, retryable: true });
        return true;
      }
      store.finishInvocation(invocationId, 'error');
      this.system(conv.id, `${agent.name} 出错：${(e as Error).message}`, { invocationId, retryable: true });
      return true;
    } finally {
      try {
        emit({ type: 'typing', conversationId: conv.id, memberId: agent.id, active: false });
      } catch (err) {
        console.error('[scheduler] typing emit failed', err);
      }
    }
  }

  private async callAdapter(
    adapter: AgentAdapter,
    conv: Conversation,
    agent: Member,
    signal: AbortSignal,
  ): Promise<{ result: InvokeResult; seenSeq: number }> {
    const session = this.deps.store.getAgentSession(conv.id, agent.id);
    const first = this.buildRequest(conv, agent, session, signal);
    try {
      return { result: await adapter.invoke(first.req), seenSeq: first.seenSeq };
    } catch (e) {
      // A stored harness session may be gone; start over once with recent history.
      if (session && e instanceof AdapterError && e.code === 'crashed') {
        const fresh = this.buildRequest(conv, agent, null, signal);
        return { result: await adapter.invoke(fresh.req), seenSeq: fresh.seenSeq };
      }
      throw e;
    }
  }

  private buildRequest(
    conv: Conversation,
    agent: Member,
    session: Session | null,
    signal: AbortSignal,
  ): { req: InvokeRequest; seenSeq: number } {
    const { store, dataDir } = this.deps;
    const members = store.listConversationMembers(conv.id);
    const nameOf = (id: string | null) => members.find((m) => m.id === id)?.name ?? '系统';
    const source = session
      ? store.listMessagesAfter(conv.id, session.lastSeenSeq).filter((m) => m.senderId !== agent.id)
      : store.listMessages(conv.id, { limit: HISTORY_REPLAY });
    const messages = source.filter((m) => m.kind === 'normal').slice(-MAX_NEW_MESSAGES);
    const workdir = join(dataDir, 'workspaces', agent.adapter!);
    mkdirSync(workdir, { recursive: true });
    const req: InvokeRequest = {
      conversationId: conv.id,
      agentName: agent.name,
      conversationTitle: conv.title,
      isGroup: conv.kind === 'group',
      harnessSessionId: session?.harnessSessionId ?? null,
      newMessages: messages.map((m) => ({
        id: m.id,
        senderName: nameOf(m.senderId),
        body: m.body,
        createdAt: m.createdAt,
        attachments: m.attachments.map((a) => this.materialize(a.file, workdir)).filter((p): p is string => p !== null),
      })),
      workdir,
      signal,
      timeoutMs: conv.settings.timeoutMs,
    };
    return { req, seenSeq: store.maxSeq(conv.id) };
  }

  /** Copies an attachment into the agent's workdir so every harness can read it. */
  private materialize(file: string, workdir: string): string | null {
    const srcRoot = resolve(this.deps.dataDir, 'attachments');
    const destRoot = resolve(workdir, 'attachments');
    const src = resolve(srcRoot, file);
    const dest = resolve(destRoot, file);
    if (!src.startsWith(srcRoot + sep) || !dest.startsWith(destRoot + sep)) return null;
    if (!existsSync(src)) return null;
    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
    return dest;
  }

  private system(conversationId: string, body: string, meta: Record<string, unknown> | null = null): void {
    const message = this.deps.store.addMessage({ conversationId, senderId: null, kind: 'system', body, meta });
    this.deps.emit({ type: 'message', message });
  }
}
