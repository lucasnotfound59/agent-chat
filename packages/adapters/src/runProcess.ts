import { spawn } from 'node:child_process';
import { AdapterError } from './types';

export interface RunOptions {
  cmd: string;
  args: string[];
  cwd: string;
  stdin?: string;
  signal: AbortSignal;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Pids of live children (each is its own process-group leader), so the hub can reap them on exit.
const livePids = new Set<number>();

export function liveProcessCount(): number {
  return livePids.size;
}

export function killAllProcessGroups(signal: NodeJS.Signals): void {
  for (const pid of livePids) {
    try {
      process.kill(-pid, signal);
    } catch {
      // group already gone
    }
  }
}

process.on('exit', () => killAllProcessGroups('SIGKILL'));

export function runProcess(o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) {
      reject(new AdapterError('aborted', 'aborted before start'));
      return;
    }
    const child = spawn(o.cmd, o.args, {
      cwd: o.cwd,
      env: o.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const pid = child.pid;
    if (pid !== undefined) livePids.add(pid);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    // Signal the whole process group so grandchildren (tool shells, MCP servers) die too.
    const signalGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) {
        child.kill(sig);
        return;
      }
      try {
        process.kill(-child.pid, sig);
      } catch {
        // group already gone
      }
    };
    const kill = () => {
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 2000);
      killTimer.unref();
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      kill();
      finish(() => reject(new AdapterError('aborted', 'aborted')));
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new AdapterError('timeout', `no result after ${o.timeoutMs} ms`)));
    }, o.timeoutMs);
    o.signal.addEventListener('abort', onAbort);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', (e) => finish(() => reject(new AdapterError('unavailable', e.message))));
    child.on('close', (code) => {
      // The group leader is gone; never signal a possibly recycled pid later.
      clearTimeout(killTimer);
      if (pid !== undefined) livePids.delete(pid);
      finish(() => resolve({ code, stdout, stderr }));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(o.stdin ?? '');
  });
}
