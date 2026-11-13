import type { MemberView, Message } from '../types';
import { Avatar } from './Avatar';
import { Markdown } from './Markdown';

export function MessageItem({ message, sender, mine }: { message: Message; sender: MemberView | undefined; mine: boolean }) {
  if (message.kind === 'system') {
    return (
      <div className="msg-system" role="note">
        {message.body}
      </div>
    );
  }
  if (mine) {
    return (
      <div className="msg msg-mine">
        <div className="bubble bubble-mine">{message.body}</div>
      </div>
    );
  }
  const name = sender?.name ?? '未知';
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="msg msg-agent">
      <Avatar name={name} />
      <div className="msg-col">
        <div className="msg-meta">
          {name} · {time}
        </div>
        <div className="bubble bubble-agent">
          <Markdown text={message.body} />
        </div>
      </div>
    </div>
  );
}
