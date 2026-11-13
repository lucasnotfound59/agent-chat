import { describe, expect, it } from 'vitest';
import { TOKEN_KEY, forgetToken, takeToken, type TokenEnv } from './token';

function env(hash: string, stored: string | null = null) {
  const store = new Map<string, string>();
  if (stored !== null) store.set(TOKEN_KEY, stored);
  const replaced: string[] = [];
  const e: TokenEnv = {
    location: { hash, pathname: '/', search: '' },
    history: { replaceState: (_d, _u, url) => void replaced.push(String(url)) },
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
  };
  return { e, store, replaced };
}

describe('takeToken', () => {
  it('reads #token=, stores it and removes it from the address bar', () => {
    const t = env('#token=a%2Bb');
    expect(takeToken(t.e)).toBe('a+b');
    expect(t.store.get(TOKEN_KEY)).toBe('a+b');
    expect(t.replaced).toEqual(['/']);
  });

  it('wipes a malformed fragment, stores nothing and falls back to the stored token', () => {
    const t = env('#token=%E0%A4%A', 'saved');
    expect(takeToken(t.e)).toBe('saved');
    expect(t.store.get(TOKEN_KEY)).toBe('saved');
    expect(t.replaced).toEqual(['/']);
    expect(takeToken(env('#token=%zz').e)).toBeNull();
  });

  it('falls back to the stored token without touching the address bar', () => {
    const t = env('', 'saved');
    expect(takeToken(t.e)).toBe('saved');
    expect(t.replaced).toEqual([]);
  });

  it('returns null when there is neither', () => {
    expect(takeToken(env('').e)).toBeNull();
  });

  it('forgetToken removes the stored token', () => {
    const t = env('', 'saved');
    forgetToken(t.e);
    expect(t.store.has(TOKEN_KEY)).toBe(false);
  });
});
