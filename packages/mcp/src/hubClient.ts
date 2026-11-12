import { execFileSync } from 'node:child_process';

export interface HubMember {
  name: string;
  adapter: string | null;
  kind: string;
  bio: string;
  available: boolean;
  reason?: string;
}

export interface HubClient {
  listMembers(): Promise<HubMember[]>;
  ask(to: string, question: string, signal?: AbortSignal): Promise<string>;
}

export class HubUnreachableError extends Error {}

const ASK_TIMEOUT_MS = 600000;

export function createHubClient(opts: {
  baseUrl: string;
  as: string;
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
}): HubClient {
  const doFetch = opts.fetchImpl ?? fetch;

  async function call(path: string, init: RequestInit): Promise<unknown> {
    const token = opts.getToken();
    if (token === null) throw new HubUnreachableError('no hub token available');
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
      });
    } catch (err) {
      // An abort from the caller's own signal is not "hub unreachable".
      if (init.signal?.aborted && (err as { name?: string }).name !== 'TypeError') throw err;
      throw new HubUnreachableError(`could not reach the hub: ${(err as Error).message}`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const msg = (body as { error?: unknown } | null)?.error;
      throw new Error(typeof msg === 'string' && msg !== '' ? msg : `hub returned HTTP ${res.status}`);
    }
    return body;
  }

  return {
    async listMembers() {
      return (await call('/api/members', { method: 'GET' })) as HubMember[];
    },
    async ask(to, question, signal) {
      const timeout = AbortSignal.timeout(ASK_TIMEOUT_MS);
      const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const body = (await call('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ as: opts.as, to, question }),
        signal: merged,
      })) as { reply?: unknown } | null;
      if (typeof body?.reply !== 'string') throw new Error('the hub returned no reply');
      return body.reply;
    },
  };
}

const KEYCHAIN_SERVICE = 'AgentChat';
const KEYCHAIN_ACCOUNT = 'hub-token';

type Run = (args: string[]) => { status: number; stdout: string };

const defaultRun: Run = (args) => {
  try {
    const stdout = execFileSync('/usr/bin/security', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    });
    return { status: 0, stdout };
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    return { status: typeof status === 'number' && status !== 0 ? status : 1, stdout: '' };
  }
};

/** Reads the hub token from the macOS keychain. Any failure (not found, denied, timeout) yields null. */
export function readTokenFromKeychain(run: Run = defaultRun): string | null {
  const r = run(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w']);
  if (r.status !== 0) return null;
  const token = r.stdout.replace(/\r?\n$/, '');
  return token === '' ? null : token;
}
