import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../types';
import { ChatHeader } from './ChatHeader';

const settings = { debounceMs: 3000, maxAgentRounds: 6, dailyInvocationCap: 200, timeoutMs: 300000, paused: false };
const group: Conversation = { id: 'g', kind: 'group', title: '讨论组', settings, memberIds: [], createdAt: 1 };

describe('ChatHeader', () => {
  it('shows the pause switch only for groups, and stop or resume', () => {
    const on = { onTogglePause: vi.fn(), onStop: vi.fn(), onResume: vi.fn() };
    const { rerender } = render(<ChatHeader conversation={group} memberNames={['我', 'Alpha']} stopped={false} {...on} />);
    expect(screen.getByRole('heading', { name: '讨论组' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '⏸ 暂停本群' }));
    expect(on.onTogglePause).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '■ 全部停止' }));
    expect(on.onStop).toHaveBeenCalled();

    rerender(<ChatHeader conversation={{ ...group, settings: { ...settings, paused: true } }} memberNames={[]} stopped {...on} />);
    expect(screen.getByRole('button', { name: '▶ 恢复本群' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '▶ 恢复' }));
    expect(on.onResume).toHaveBeenCalled();

    rerender(<ChatHeader conversation={{ ...group, kind: 'dm' }} memberNames={[]} stopped={false} {...on} />);
    expect(screen.queryByRole('button', { name: '⏸ 暂停本群' })).toBeNull();
  });

  it('still offers stop with no conversation open', () => {
    render(<ChatHeader conversation={null} memberNames={[]} stopped={false} onTogglePause={() => {}} onStop={() => {}} onResume={() => {}} />);
    expect(screen.getByRole('button', { name: '■ 全部停止' })).toBeTruthy();
  });
});
