import { dmAgent, sidebarGroups, type ChatState, type Connection } from '../store';
import type { Conversation } from '../types';
import { Avatar } from './Avatar';

export const CONNECTION_TEXT: Record<Connection, string> = {
  connecting: '正在连接…',
  open: '已连接 hub',
  closed: '连接中断，正在重连…',
  hub_down: 'hub 没有运行',
  unauthorized: '访问令牌无效',
};

interface Props {
  state: ChatState;
  activeId: string | null;
  onSelect(id: string): void;
  onNewGroup(): void;
  onRefresh(): void;
}

export function Sidebar({ state, activeId, onSelect, onNewGroup, onRefresh }: Props) {
  const { groups, dms, asks } = sidebarGroups(state);
  const item = (c: Conversation) => <Item key={c.id} c={c} state={state} active={c.id === activeId} onSelect={onSelect} />;
  return (
    <nav className="sidebar">
      <div className="sidebar-top">
        <b>Agent Chat</b>
        <button className="new-group" onClick={onNewGroup}>
          ＋ 群聊
        </button>
      </div>
      <div className="sidebar-list">
        <div className="sidebar-heading">群聊</div>
        {groups.length ? groups.map(item) : <div className="sidebar-empty">还没有群聊</div>}
        <div className="sidebar-heading">私聊</div>
        {dms.map(item)}
        <div className="sidebar-heading">agent 互问</div>
        {asks.length ? asks.map(item) : <div className="sidebar-empty">还没有 agent 之间的提问</div>}
      </div>
      <div className="sidebar-foot">
        <span>{CONNECTION_TEXT[state.connection]}</span>
        <button className="link" onClick={onRefresh}>
          重新检查可用状态
        </button>
      </div>
    </nav>
  );
}

function Item({ c, state, active, onSelect }: { c: Conversation; state: ChatState; active: boolean; onSelect(id: string): void }) {
  const agent = c.kind === 'dm' ? dmAgent(state, c) : undefined;
  const unavailable = agent?.availability && !agent.availability.ok ? (agent.availability.reason ?? '不可用') : null;
  const last = state.lastMessage[c.id];
  const sender = last?.senderId ? state.members.find((m) => m.id === last.senderId)?.name : undefined;
  const summary = last ? `${last.kind === 'system' ? '系统' : (sender ?? '未知')}：${last.body}` : '';
  return (
    <button
      className={`conv${active ? ' conv-active' : ''}${unavailable ? ' conv-off' : ''}`}
      aria-label={c.title}
      aria-current={active ? 'true' : undefined}
      onClick={() => onSelect(c.id)}
    >
      <Avatar name={c.kind === 'ask' ? '⇄' : c.title} dot={agent ? (unavailable ? 'off' : 'on') : undefined} />
      <span className="conv-text">
        <span className="conv-title">
          {c.title}
          {unavailable && <span className="conv-reason">{unavailable}</span>}
        </span>
        {c.kind !== 'dm' && summary && <span className="conv-summary">{summary}</span>}
      </span>
    </button>
  );
}
