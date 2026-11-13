import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { initialState, reduce } from '../store';
import type { StateResponse } from '../types';
import { Sidebar } from './Sidebar';

const settings = { debounceMs: 3000, maxAgentRounds: 6, dailyInvocationCap: 200, timeoutMs: 300000, paused: false };
const state: StateResponse = {
  me: { id: 'me', kind: 'human', name: '我', bio: '', adapter: null },
  members: [
    { id: 'me', kind: 'human', name: '我', bio: '', adapter: null, availability: null },
    { id: 'a', kind: 'agent', name: 'Alpha', bio: '', adapter: 'fake-a', availability: { ok: true } },
    { id: 'c', kind: 'agent', name: 'Claude Code', bio: '', adapter: 'claude', availability: { ok: false, reason: '未登录' } },
  ],
  conversations: [
    { id: 'dm-a', kind: 'dm', title: 'Alpha', settings, memberIds: ['me', 'a'], createdAt: 1, lastMessage: null },
    { id: 'dm-c', kind: 'dm', title: 'Claude Code', settings, memberIds: ['me', 'c'], createdAt: 2, lastMessage: null },
    {
      id: 'g', kind: 'group', title: '讨论组', settings, memberIds: ['me', 'a'], createdAt: 3,
      lastMessage: { id: 'm', seq: 1, conversationId: 'g', senderId: 'a', kind: 'normal', body: '同意', mentions: [], replyTo: null, attachments: [], meta: null, createdAt: 5 },
    },
    { id: 'q', kind: 'ask', title: 'Alpha → Claude Code', settings, memberIds: ['a', 'c'], createdAt: 4, lastMessage: null },
  ],
  stopped: false,
};

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    state: { ...reduce(initialState, { type: 'state', state }), connection: 'open' as const },
    activeId: 'g',
    onSelect: vi.fn(),
    onNewGroup: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
  render(<Sidebar {...props} />);
  return props;
}

describe('Sidebar', () => {
  it('lists groups, private chats and asks under their headings, with the last message', () => {
    renderSidebar();
    expect(screen.getByText('群聊')).toBeTruthy();
    expect(screen.getByText('私聊')).toBeTruthy();
    expect(screen.getByText('agent 互问')).toBeTruthy();
    expect(screen.getByRole('button', { name: '讨论组' }).textContent).toContain('Alpha：同意');
    expect(screen.getByRole('button', { name: '讨论组' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Alpha → Claude Code' })).toBeTruthy();
  });

  it('shows why an agent is unavailable', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Claude Code' }).textContent).toContain('未登录');
  });

  it('selects a conversation, opens the new-group dialog and refreshes availability', () => {
    const p = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(p.onSelect).toHaveBeenCalledWith('dm-a');
    fireEvent.click(screen.getByRole('button', { name: '＋ 群聊' }));
    expect(p.onNewGroup).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新检查可用状态' }));
    expect(p.onRefresh).toHaveBeenCalled();
    expect(screen.getByText('已连接 hub')).toBeTruthy();
  });
});
