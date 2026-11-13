export const TOKEN_KEY = 'agentchat.token';

export interface TokenEnv {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url?: string | URL | null): void };
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
}

function browserEnv(): TokenEnv {
  return { location: window.location, history: window.history, storage: window.localStorage };
}

/** Takes the token from `#token=…` (saving it and wiping it from the address bar) or from storage. */
export function takeToken(env: TokenEnv = browserEnv()): string | null {
  const m = /(?:^#|&)token=([^&]+)/.exec(env.location.hash);
  if (m) {
    let token: string | null = null;
    try {
      token = decodeURIComponent(m[1]);
    } catch {
      // malformed escape: ignore the fragment, but still wipe it below
    }
    if (token !== null) {
      try {
        env.storage.setItem(TOKEN_KEY, token);
      } catch {
        // storage may be blocked; the token still works for this page load
      }
    }
    env.history.replaceState(null, '', env.location.pathname + env.location.search);
    if (token !== null) return token;
  }
  try {
    return env.storage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function forgetToken(env: TokenEnv = browserEnv()): void {
  try {
    env.storage.removeItem(TOKEN_KEY);
  } catch {
    // nothing to forget
  }
}
