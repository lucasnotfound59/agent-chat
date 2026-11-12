import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const KEYCHAIN_SERVICE = 'AgentChat';
export const KEYCHAIN_ACCOUNT = 'hub-token';

export interface TokenStore {
  get(): string | null;
  set(token: string): void;
}

export class MemoryTokenStore implements TokenStore {
  private token: string | null;
  constructor(initial: string | null = null) {
    this.token = initial;
  }
  get(): string | null {
    return this.token;
  }
  set(token: string): void {
    this.token = token;
  }
}

type Run = (args: string[]) => { status: number; stdout: string };

const defaultRun: Run = (args) => {
  try {
    const stdout = execFileSync('/usr/bin/security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { status: 0, stdout };
  } catch (err) {
    const status = (err as { status?: number }).status;
    return { status: typeof status === 'number' && status !== 0 ? status : 1, stdout: '' };
  }
};

export class KeychainTokenStore implements TokenStore {
  constructor(private readonly run: Run = defaultRun) {}

  get(): string | null {
    const r = this.run(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w']);
    if (r.status !== 0) return null;
    return r.stdout.replace(/\r?\n$/, '');
  }

  set(token: string): void {
    const r = this.run(['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', token]);
    if (r.status !== 0) {
      throw new Error(`could not write the token to the macOS keychain (service ${KEYCHAIN_SERVICE}, account ${KEYCHAIN_ACCOUNT}; exit ${r.status})`);
    }
  }
}

export function ensureToken(store: TokenStore, legacy: string | null = null): string {
  const existing = store.get();
  if (typeof existing === 'string' && existing !== '') return existing;
  const token = typeof legacy === 'string' && legacy !== '' ? legacy : randomBytes(24).toString('hex');
  store.set(token);
  return token;
}
