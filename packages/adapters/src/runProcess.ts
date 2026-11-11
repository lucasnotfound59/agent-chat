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

export function runProcess(o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) {
      reject(new AdapterError('aborted', 'aborted before start'));
      return;
    }
    const child = spawn(o.cmd, o.args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const kill = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
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
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })));
    child.stdin.on('error', () => {});
    child.stdin.end(o.stdin ?? '');
  });
}
