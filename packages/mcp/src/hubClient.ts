import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';

export interface HubMember {
  name: string;
  adapter: string | null;
  kind: string;
  bio: string;
  available: boolean;
  reason?: string;
}

export interface HubClient {
  listMembers(signal?: AbortSignal): Promise<HubMember[]>;
  ask(to: string, question: string, signal?: AbortSignal): Promise<string>;
}

export class HubUnreachableError extends Error {}

const ASK_TIMEOUT_MS = 600000;
const LIST_TIMEOUT_MS = 30000;
const ASK_TIMEOUT_MESSAGE = 'The hub did not answer within 10 minutes.';
const LIST_TIMEOUT_MESSAGE = 'The hub did not answer within 30 seconds.';

/**
 * fetch-shaped transport on node:http. Node's built-in fetch gives up waiting for response headers after
 * 300 s, which would cut a long ask short and be mistaken for "hub not running"; node:http has no such
 * limit, so the caller's own timeout signal is the only clock. Redirects are never followed.
 */
const httpFetch = ((url: string | URL | Request, init?: RequestInit): Promise<Response> =>
  new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const req = httpRequest(
      String(url),
      { method: init?.method ?? 'GET', headers: init?.headers as Record<string, string> | undefined },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          req.destroy();
          reject(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', (e) => reject(e));
        res.on('end', () => {
          const headers = new Headers();
          const ct = res.headers['content-type'];
          if (typeof ct === 'string') headers.set('content-type', ct);
          const noBody = status === 204 || status === 205 || status === 304 || status < 200;
          resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, headers }));
        });
      },
    );
    const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    req.on('error', (e) => reject(signal?.aborted ? signal.reason : new TypeError('fetch failed', { cause: e })));
    if (typeof init?.body === 'string') req.write(init.body);
    req.end();
  })) as typeof fetch;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The token must never leave loopback, whatever base URL the caller passes. */
function assertLoopbackBaseUrl(baseUrl: string): void {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error('hub base URL is not a valid URL');
  }
  if (u.username !== '' || u.password !== '' || !LOOPBACK_HOSTS.has(u.hostname)) {
    throw new Error('hub base URL must be a loopback address without credentials');
  }
}

/** Builds the hub URL from AGENTCHAT_PORT; throws unless it is unset or a decimal port 1-65535. */
export function resolveBaseUrl(portEnv: string | undefined): string {
  let port = 4317;
  if (portEnv !== undefined) {
    if (!/^\d{1,5}$/.test(portEnv) || Number(portEnv) < 1 || Number(portEnv) > 65535) {
      throw new Error('AGENTCHAT_PORT must be a port number between 1 and 65535');
    }
    port = Number(portEnv);
  }
  const url = `http://127.0.0.1:${port}`;
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.username !== '' || u.password !== '' || u.port !== String(port)) {
    throw new Error('AGENTCHAT_PORT produced an unexpected hub URL');
  }
  return url;
}

export function createHubClient(opts: {
  baseUrl: string;
  as: string;
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  listTimeoutMs?: number;
}): HubClient {
  assertLoopbackBaseUrl(opts.baseUrl);
  const timeoutMs = opts.timeoutMs ?? ASK_TIMEOUT_MS;
  const listTimeoutMs = opts.listTimeoutMs ?? LIST_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? httpFetch;

  async function call(path: string, init: RequestInit, timeoutMessage: string): Promise<unknown> {
    const token = opts.getToken();
    if (token === null) throw new HubUnreachableError('no hub token available');
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}${path}`, {
        ...init,
        redirect: 'error',
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
      });
    } catch (err) {
      // Timeouts and cancellations are not "hub unreachable".
      if (init.signal?.aborted) {
        if ((init.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError') {
          throw new Error(timeoutMessage);
        }
        throw err;
      }
      // undici's own headers/body timeouts are timeouts, not a missing hub.
      const code = (err as { cause?: { code?: unknown } }).cause?.code;
      if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') throw new Error(timeoutMessage);
      // undici reports a refused redirect as a TypeError whose cause says "unexpected redirect".
      if (/unexpected redirect/i.test(String((err as { cause?: { message?: unknown } }).cause?.message ?? ''))) {
        throw new Error('The hub answered with a redirect, which is not allowed.');
      }
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
    async listMembers(signal) {
      const timeout = AbortSignal.timeout(listTimeoutMs);
      const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const body = await call('/api/members', { method: 'GET', signal: merged }, LIST_TIMEOUT_MESSAGE);
      if (!Array.isArray(body)) throw new Error('The hub returned an unexpected members response.');
      return body as HubMember[];
    },
    async ask(to, question, signal) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const body = (await call(
        '/api/ask',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ as: opts.as, to, question }),
          signal: merged,
        },
        ASK_TIMEOUT_MESSAGE,
      )) as { reply?: unknown } | null;
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
