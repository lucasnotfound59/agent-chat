import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MemberView } from '../types';
import { NewGroupDialog } from './NewGroupDialog';

const agents: MemberView[] = [
  { id: 'a', kind: 'agent', name: 'Alpha', bio: '', adapter: 'fake-a', availability: { ok: true } },
  { id: 'b', kind: 'agent', name: 'Beta', bio: '', adapter: 'fake-b', availability: { ok: false, reason: '未登录' } },
];

describe('NewGroupDialog', () => {
  it('requires a title and at least one agent', async () => {
    const onCreate = vi.fn();
    render(<NewGroupDialog agents={agents} onCreate={onCreate} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByRole('alert').textContent).toBe('请填写群名');
    fireEvent.change(screen.getByLabelText('群名'), { target: { value: '讨论组' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByRole('alert').textContent).toBe('至少选一个 agent');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('creates with the chosen agents and shows a failure in place', async () => {
    const onCreate = vi.fn().mockRejectedValueOnce(new Error('title and memberIds are required')).mockResolvedValueOnce(undefined);
    render(<NewGroupDialog agents={agents} onCreate={onCreate} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('群名'), { target: { value: '讨论组' } });
    fireEvent.click(screen.getByLabelText('Alpha'));
    expect(screen.getByLabelText('Beta（未登录）')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('title and memberIds are required'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    expect(onCreate).toHaveBeenLastCalledWith('讨论组', ['a']);
  });
});
