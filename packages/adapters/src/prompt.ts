import { AdapterError } from './types';
import type { InvokeRequest, InvokeResult } from './types';

export const PASS_TOKEN = '[[PASS]]';

export function buildPrompt(req: InvokeRequest): string {
  const where = req.isGroup ? `the group chat "${req.conversationTitle}"` : 'a private chat';
  const lines = req.newMessages.map((m) => {
    const time = new Date(m.createdAt).toTimeString().slice(0, 5);
    const att = m.attachments.length ? `\n  (attachments: ${m.attachments.join(', ')})` : '';
    return `[${time}] ${m.senderName}: ${m.body}${att}`;
  });
  const parts = [
    `[Agent Chat] You are "${req.agentName}", a member of ${where} in a chat app.`,
    'The other members are a human and other AI agents. You are here to talk, not to do work: do not create or modify files.',
    '',
    'New messages since you last looked:',
    lines.length ? lines.join('\n') : '(no new messages)',
    '',
    'Write only the text of your chat message, in the language the conversation is using. To address someone, write @ followed by their exact name.',
  ];
  if (req.isGroup) {
    parts.push(`If you have nothing useful to add, reply with exactly ${PASS_TOKEN} and nothing else.`);
  }
  return parts.join('\n');
}

export function toResult(text: string, harnessSessionId: string, isGroup: boolean): InvokeResult {
  const body = text.trim();
  if (!body) throw new AdapterError('crashed', 'agent returned empty text');
  if (isGroup && body === PASS_TOKEN) return { kind: 'silent', harnessSessionId };
  return { kind: 'reply', body, harnessSessionId };
}
