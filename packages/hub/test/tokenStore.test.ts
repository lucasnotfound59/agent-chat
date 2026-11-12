import { describe, expect, it } from 'vitest';
import { KeychainTokenStore, MemoryTokenStore, ensureToken } from '../src/tokenStore';

describe('KeychainTokenStore', () => {
  it('get returns the trimmed output on success', () => {
    const calls: string[][] = [];
    const s = new KeychainTokenStore((args) => {
      calls.push(args);
      return { status: 0, stdout: 'abc123\n' };
    });
    expect(s.get()).toBe('abc123');
    expect(calls).toEqual([['find-generic-password', '-s', 'AgentChat', '-a', 'hub-token', '-w']]);
  });

  it('get returns null only when the item is not found (exit 44)', () => {
    expect(new KeychainTokenStore(() => ({ status: 44, stdout: '' })).get()).toBeNull();
  });

  it('get throws on any other failure, naming service, account and status', () => {
    const s = new KeychainTokenStore(() => ({ status: 51, stdout: 'secret-ish' }));
    expect(() => s.get()).toThrow(/AgentChat.*hub-token.*51/s);
  });

  it('ensureToken propagates a read failure and never overwrites the entry', () => {
    let sets = 0;
    const s = new KeychainTokenStore((args) => {
      if (args[0] === 'add-generic-password') sets++;
      return { status: 51, stdout: '' };
    });
    expect(() => ensureToken(s, 'legacy')).toThrow(/51/);
    expect(sets).toBe(0);
  });

  it('set passes exact arguments', () => {
    const calls: string[][] = [];
    new KeychainTokenStore((args) => {
      calls.push(args);
      return { status: 0, stdout: '' };
    }).set('tok');
    expect(calls).toEqual([['add-generic-password', '-U', '-s', 'AgentChat', '-a', 'hub-token', '-w', 'tok']]);
  });

  it('set throws a described error on failure', () => {
    const s = new KeychainTokenStore(() => ({ status: 1, stdout: '' }));
    expect(() => s.set('tok')).toThrow(/keychain/i);
  });
});

describe('ensureToken', () => {
  it('returns an existing token', () => {
    const s = new MemoryTokenStore('existing');
    expect(ensureToken(s, 'legacy')).toBe('existing');
    expect(s.get()).toBe('existing');
  });
  it('migrates a legacy token', () => {
    const s = new MemoryTokenStore(null);
    expect(ensureToken(s, 'legacy')).toBe('legacy');
    expect(s.get()).toBe('legacy');
  });
  it('treats an empty stored token as missing', () => {
    const s = new MemoryTokenStore('');
    expect(ensureToken(s, 'legacy')).toBe('legacy');
  });
  it('generates a fresh token', () => {
    const s = new MemoryTokenStore();
    const t = ensureToken(s, null);
    expect(t).toMatch(/^[0-9a-f]{48}$/);
    expect(s.get()).toBe(t);
    expect(ensureToken(s, null)).toBe(t);
  });
  it('ignores an empty legacy token', () => {
    expect(ensureToken(new MemoryTokenStore(), '')).toMatch(/^[0-9a-f]{48}$/);
  });
});
