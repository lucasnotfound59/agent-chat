import type { Scheduler } from './scheduler';
import type { Store } from './store';
import type { HubEvent, Member } from './types';

export type AskErrorCode = 'bad_request' | 'unavailable' | 'stopped' | 'capped' | 'timeout' | 'failed' | 'aborted';

export class AskError extends Error {
  constructor(
    public code: AskErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AskError';
  }
}

export interface AskDeps {
  store: Store;
  scheduler: Scheduler;
  isAvailable: (adapter: string) => boolean;
  availabilityReason: (adapter: string) => string | undefined;
  /** Receives `conversation` and `message` events (the hub passes its bus). */
  emit?: (e: HubEvent) => void;
}

const MAX_QUESTION = 20000;

export class AskService {
  constructor(private readonly deps: AskDeps) {}

  async ask(input: { as: string; to: string; question: string; signal: AbortSignal }): Promise<{ reply: string; conversationId: string }> {
    const { store, scheduler } = this.deps;
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    if (!question) throw new AskError('bad_request', '问题不能为空');
    if (question.length > MAX_QUESTION) throw new AskError('bad_request', `问题太长（最多 ${MAX_QUESTION} 个字符）`);
    const agents = store.listMembers().filter((m) => m.kind === 'agent');
    const asker = typeof input.as === 'string' ? agents.find((m) => m.adapter === input.as) : undefined;
    if (!asker) throw new AskError('bad_request', `无法识别提问者：${String(input.as)}`);
    const target =
      typeof input.to === 'string' ? agents.find((m) => m.name === input.to) ?? agents.find((m) => m.adapter === input.to) : undefined;
    if (!target) throw new AskError('bad_request', `找不到可以提问的 agent：${String(input.to)}`);
    if (target.id === asker.id) throw new AskError('bad_request', '不能向自己提问');

    const adapter = target.adapter!;
    if (!this.deps.isAvailable(adapter)) {
      throw new AskError('unavailable', `${target.name} 现在不可用：${this.deps.availabilityReason(adapter) ?? '未知原因'}`);
    }

    // Refuse before storing anything when the hub is stopped or the conversation is at its daily cap.
    const gate = scheduler.askAdmission(store.findAskConversation(asker.id, target.id)?.id ?? null);
    if (gate === 'stopped') throw new AskError('stopped', '已全局停止，暂不处理提问');
    if (gate === 'capped') throw new AskError('capped', '今日唤起次数已达上限');

    // Find-or-create and the question insert are synchronous, so concurrent asks cannot create two.
    const { conversation, created } = this.conversationFor(asker, target);
    if (created) this.emit({ type: 'conversation', conversation });
    const message = store.addMessage({
      conversationId: conversation.id,
      senderId: asker.id,
      body: question,
      meta: { via: 'mcp' },
    });
    this.emit({ type: 'message', message });

    const result = await scheduler.invokeForAsk(conversation.id, target.id, input.signal, message.seq);
    switch (result.kind) {
      case 'reply':
        return { reply: result.body, conversationId: conversation.id };
      case 'silent':
        throw new AskError('failed', `${target.name} 没有给出回答`);
      case 'timeout':
        throw new AskError('timeout', result.message);
      case 'error':
        throw new AskError('failed', result.message);
      case 'aborted':
        throw new AskError('aborted', result.message);
      case 'capped':
        throw new AskError('capped', result.message);
      case 'stopped':
        throw new AskError('stopped', result.message);
    }
  }

  private conversationFor(asker: Member, target: Member) {
    const { store } = this.deps;
    const existing = store.findAskConversation(asker.id, target.id);
    if (existing) return { conversation: existing, created: false };
    const conversation = store.createConversation({
      kind: 'ask',
      title: `${asker.name} → ${target.name}`,
      memberIds: [asker.id, target.id],
      askFrom: asker.id,
      askTo: target.id,
    });
    return { conversation, created: true };
  }

  private emit(e: HubEvent): void {
    this.deps.emit?.(e);
  }
}
