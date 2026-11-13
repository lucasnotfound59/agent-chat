import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MemberView, Message } from '../types';
import { Avatar } from './Avatar';
import { MessageItem } from './MessageItem';

interface Props {
  messages: Message[];
  members: MemberView[];
  meId: string | null;
  typingIds: string[];
  hasMore: boolean;
  onLoadOlder(): Promise<void>;
}

export function MessageList({ messages, members, meId, typingIds, hasMore, onLoadOlder }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const restore = useRef<{ height: number; top: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (restore.current) {
      // Older messages were prepended: keep what the reader was looking at in place.
      el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top;
      restore.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, typingIds.length]);

  const onScroll = async () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 40 && hasMore && !loading) {
      setLoading(true);
      restore.current = { height: el.scrollHeight, top: el.scrollTop };
      try {
        await onLoadOlder();
      } catch {
        restore.current = null;
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="messages" ref={ref} onScroll={() => void onScroll()}>
      {hasMore && <div className="load-more">{loading ? '加载中…' : '向上滚动加载更早的消息'}</div>}
      {messages.map((m) => (
        <MessageItem key={m.id} message={m} sender={m.senderId ? byId.get(m.senderId) : undefined} mine={m.senderId !== null && m.senderId === meId} />
      ))}
      {typingIds.map((id) => {
        const name = byId.get(id)?.name ?? '?';
        return (
          <div key={id} className="msg msg-agent" aria-label={`${name} 正在输入`}>
            <Avatar name={name} />
            <div className="bubble bubble-typing">●●●</div>
          </div>
        );
      })}
    </div>
  );
}
