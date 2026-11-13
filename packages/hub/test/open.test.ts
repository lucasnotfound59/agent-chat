import { describe, expect, it } from 'vitest';
import { openBrowser, webUrl } from '../src/open';

describe('webUrl / openBrowser', () => {
  it('puts the token in the fragment, URL-encoded', () => {
    expect(webUrl(4317, 'a+b/c')).toBe('http://127.0.0.1:4317/#token=a%2Bb%2Fc');
  });

  it('runs `open` with the URL', () => {
    const calls: Array<[string, string[]]> = [];
    expect(openBrowser('http://x/', {}, (cmd, args) => calls.push([cmd, args]))).toBe(true);
    expect(calls).toEqual([['open', ['http://x/']]]);
  });

  it('does nothing when AGENTCHAT_NO_OPEN=1', () => {
    const calls: unknown[] = [];
    expect(openBrowser('http://x/', { AGENTCHAT_NO_OPEN: '1' }, () => calls.push(1))).toBe(false);
    expect(calls).toEqual([]);
  });
});
