import type { Conversation } from '../types';

interface Props {
  conversation: Conversation | null;
  memberNames: string[];
  stopped: boolean;
  onTogglePause(): void;
  onStop(): void;
  onResume(): void;
}

export function ChatHeader({ conversation, memberNames, stopped, onTogglePause, onStop, onResume }: Props) {
  const paused = conversation?.settings.paused ?? false;
  return (
    <header className="chat-header">
      <div className="chat-title">
        <h2>{conversation?.title ?? 'Agent Chat'}</h2>
        {memberNames.length > 0 && <span className="chat-members">{memberNames.join('、')}</span>}
      </div>
      <div className="chat-actions">
        {conversation?.kind === 'group' && (
          <button className={`pill${paused ? ' pill-on' : ''}`} aria-pressed={paused} onClick={onTogglePause}>
            {paused ? '▶ 恢复本群' : '⏸ 暂停本群'}
          </button>
        )}
        {stopped ? (
          <button className="pill pill-resume" onClick={onResume}>
            ▶ 恢复
          </button>
        ) : (
          <button className="pill pill-stop" onClick={onStop}>
            ■ 全部停止
          </button>
        )}
      </div>
    </header>
  );
}
