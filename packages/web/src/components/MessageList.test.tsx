import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MemberView, Message } from '../types';
import { MessageList } from './MessageList';

const members: MemberView[] = [
  { id: 'me', kind: 'human', name: '我', bio: '', adapter: null, availability: null },
  { id: 'a', kind: 'agent', name: 'Alpha', bio: '', adapter: 'fake-a', availability: { ok: true } },
];
const m = (id: string, senderId: string | null, body: string, kind: Message['kind'] = 'normal'): Message => ({
  id, seq: Number(id.slice(1)), conversationId: 'c', senderId, kind, body, mentions: [], replyTo: null, attachments: [], meta: null, createdAt: 0,
});

describe('MessageList', () => {
  it('puts my messages right as plain text, agent messages left as Markdown, system messages centered', () => {
    const { container } = render(
      <MessageList
        messages={[m('m1', 'me', '**原样**'), m('m2', 'a', '**粗体**'), m('m3', null, 'Alpha 没有回应（超时）。', 'system')]}
        members={members}
        meId="me"
        typingIds={['a']}
        hasMore={false}
        onLoadOlder={async () => {}}
      />,
    );
    expect(container.querySelector('.msg-mine .bubble')?.textContent).toBe('**原样**');
    expect(container.querySelector('.msg-agent strong')?.textContent).toBe('粗体');
    expect(screen.getByRole('note').textContent).toBe('Alpha 没有回应（超时）。');
    expect(screen.getByLabelText('Alpha 正在输入')).toBeTruthy();
  });

  it('says when older messages can be loaded', () => {
    render(<MessageList messages={[]} members={members} meId="me" typingIds={[]} hasMore onLoadOlder={async () => {}} />);
    expect(screen.getByText('向上滚动加载更早的消息')).toBeTruthy();
  });

  it('shows a retry button after a failed load and does not retry on further scrolls', async () => {
    const onLoadOlder = vi.fn().mockRejectedValue(new Error('boom'));
    const { container } = render(<MessageList messages={[]} members={members} meId="me" typingIds={[]} hasMore onLoadOlder={onLoadOlder} />);
    const el = container.querySelector('.messages') as HTMLElement;
    fireEvent.scroll(el);
    await waitFor(() => expect(screen.getByRole('button', { name: '加载失败，点击重试' })).toBeTruthy());
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    fireEvent.scroll(el);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '加载失败，点击重试' }));
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(2));
  });
});
