import { useState } from 'react';
import { ChatHeader } from './components/ChatHeader';
import { Composer } from './components/Composer';
import { MessageList } from './components/MessageList';
import { NewGroupDialog } from './components/NewGroupDialog';
import { Sidebar } from './components/Sidebar';
import { takeToken } from './token';
import { useChat } from './useChat';

export function App() {
  const [token] = useState(() => takeToken());
  if (!token) return <NoToken expired={false} />;
  return <Chat token={token} />;
}

function NoToken({ expired }: { expired: boolean }) {
  return (
    <div className="no-token">
      <h1>Agent Chat</h1>
      <p>{expired ? '访问令牌已失效。' : '这个浏览器还没有访问令牌。'}</p>
      <p>
        请用终端里 <code>npm run hub</code> 打印的地址（以 <code>#token=</code> 结尾）重新打开这个页面。
      </p>
    </div>
  );
}

function Chat({ token }: { token: string }) {
  const chat = useChat(token);
  const [dialog, setDialog] = useState(false);
  const { state } = chat;
  if (state.connection === 'unauthorized') return <NoToken expired />;

  const conv = state.conversations.find((c) => c.id === chat.activeId) ?? null;
  const convMembers = conv ? state.members.filter((m) => conv.memberIds.includes(m.id)) : [];
  const candidates = conv?.kind === 'group' ? convMembers.filter((m) => m.kind === 'agent') : [];

  return (
    <div className="app">
      <Sidebar
        state={state}
        activeId={chat.activeId}
        onSelect={chat.select}
        onNewGroup={() => setDialog(true)}
        onRefresh={() => void chat.refreshAvailability()}
      />
      <main className="chat">
        <ChatHeader
          conversation={conv}
          memberNames={convMembers.map((m) => m.name)}
          stopped={state.stopped}
          onTogglePause={() => void chat.togglePause()}
          onStop={() => void chat.stop()}
          onResume={() => void chat.resume()}
        />
        {(state.connection === 'hub_down' || state.connection === 'closed') && (
          <div className="banner" role="status">
            hub 没有运行，请在终端运行 <code>npm run hub</code>，页面会自动重连。
          </div>
        )}
        {conv ? (
          <>
            <MessageList
              key={conv.id}
              messages={state.messages[conv.id] ?? []}
              members={state.members}
              meId={state.me?.id ?? null}
              typingIds={state.typing[conv.id] ?? []}
              hasMore={state.hasMore[conv.id] ?? false}
              onLoadOlder={chat.loadOlder}
            />
            <Composer
              key={conv.id}
              candidates={candidates}
              onSend={chat.send}
              placeholder={conv.kind === 'ask' ? '在这里插话，被问的 agent 会回答' : '发消息，@ 提到成员'}
            />
          </>
        ) : (
          <div className="empty">选择左侧的会话开始聊天</div>
        )}
      </main>
      {dialog && (
        <NewGroupDialog
          agents={state.members.filter((m) => m.kind === 'agent')}
          onClose={() => setDialog(false)}
          onCreate={async (title, ids) => {
            await chat.createGroup(title, ids);
            setDialog(false);
          }}
        />
      )}
    </div>
  );
}
