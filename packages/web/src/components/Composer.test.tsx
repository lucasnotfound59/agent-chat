import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MemberView } from '../types';
import { Composer } from './Composer';

const candidates: MemberView[] = [
  { id: 'a', kind: 'agent', name: 'Alpha', bio: '', adapter: 'fake-a', availability: { ok: true } },
  { id: 'b', kind: 'agent', name: 'Beta', bio: '', adapter: 'fake-b', availability: { ok: false, reason: '未登录' } },
];
const box = () => screen.getByLabelText('消息') as HTMLTextAreaElement;

describe('Composer', () => {
  it('sends on Enter, keeps Shift+Enter for a new line, and clears after sending', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer candidates={[]} onSend={onSend} />);
    fireEvent.change(box(), { target: { value: '你好' } });
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('你好'));
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('completes an @mention with Enter, then sends with the next Enter', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer candidates={candidates} onSend={onSend} />);
    fireEvent.change(box(), { target: { value: '看看 @Be' } });
    expect(screen.getByRole('option', { name: '@Beta（未登录）' })).toBeTruthy();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('看看 @Beta ');
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('看看 @Beta'));
  });

  it('keeps the text and shows the reason when sending fails', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('empty message'));
    render(<Composer candidates={[]} onSend={onSend} />);
    fireEvent.change(box(), { target: { value: '你好' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('发送失败：empty message'));
    expect(box().value).toBe('你好');
  });

  it('does not send while an input method is composing', () => {
    const onSend = vi.fn();
    render(<Composer candidates={[]} onSend={onSend} />);
    fireEvent.change(box(), { target: { value: 'ni' } });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send on the Safari composition-ending Enter (keyCode 229)', () => {
    const onSend = vi.fn();
    render(<Composer candidates={[]} onSend={onSend} />);
    fireEvent.change(box(), { target: { value: 'ni' } });
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });
});
