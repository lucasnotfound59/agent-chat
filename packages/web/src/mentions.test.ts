import { describe, expect, it } from 'vitest';
import { applyMention, filterMembers, mentionQuery } from './mentions';

describe('mentions', () => {
  it('finds the @word at the caret', () => {
    expect(mentionQuery('你好 @Op', 6)).toEqual({ start: 3, query: 'Op' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('a@b', 3)).toBeNull();
    expect(mentionQuery('@Alpha 你好', 9)).toBeNull();
  });

  it('filters by name, prefix matches first, case-insensitive', () => {
    const ms = [{ name: 'OpenCode' }, { name: 'Claude Code' }, { name: 'Codex' }];
    expect(filterMembers(ms, 'co').map((m) => m.name)).toEqual(['Codex', 'OpenCode', 'Claude Code']);
  });

  it('replaces the @word with the full name and a space', () => {
    expect(applyMention('看 @Op 呢', 2, 5, 'OpenCode')).toEqual({ text: '看 @OpenCode  呢', caret: 12 });
  });
});
