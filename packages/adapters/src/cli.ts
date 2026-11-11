import { runProcess } from './runProcess';
import { toResult } from './prompt';
import { AdapterError } from './types';
import type { Availability, InvokeRequest, InvokeResult } from './types';

export function jsonLines(stdout: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // not a JSON event line
    }
  }
  return out;
}

export type ParseOutput = (stdout: string, fallbackSessionId: string | null) => { text: string; sessionId: string };

export async function invokeCli(
  spec: { cmd: string; args: string[]; stdin?: string },
  req: InvokeRequest,
  parse: ParseOutput,
): Promise<InvokeResult> {
  req.onTyping?.();
  const r = await runProcess({
    cmd: spec.cmd,
    args: spec.args,
    stdin: spec.stdin,
    cwd: req.workdir,
    signal: req.signal,
    timeoutMs: req.timeoutMs,
  });
  let parsed: { text: string; sessionId: string };
  try {
    parsed = parse(r.stdout, req.harnessSessionId);
  } catch (e) {
    throw new AdapterError('crashed', `${(e as Error).message}; exit ${r.code}; ${r.stderr.slice(-500).trim()}`);
  }
  return toResult(parsed.text, parsed.sessionId, req.isGroup);
}

export async function checkCommand(cmd: string, label: string): Promise<Availability> {
  try {
    const r = await runProcess({
      cmd,
      args: ['--version'],
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 15000,
    });
    return r.code === 0 ? { ok: true } : { ok: false, reason: `${label} 无法运行（退出码 ${r.code}）` };
  } catch {
    return { ok: false, reason: `未找到 ${label} 的命令 ${cmd}` };
  }
}
