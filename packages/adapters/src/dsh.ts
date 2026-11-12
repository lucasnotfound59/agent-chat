import { checkCommand, completeCli, invokeCli, jsonLines } from './cli';
import { buildPrompt } from './prompt';
import type { AgentAdapter, ArgsRequest, Availability, CompleteRequest, InvokeRequest, InvokeResult } from './types';

export function dshArgs(req: ArgsRequest, patchPath: string | null): string[] {
  const args = ['--profile', 'headless'];
  if (patchPath) args.push('--patch', patchPath);
  args.push('--json', '--permission-mode', 'read-only', '--approval-policy', 'never');
  if (req.harnessSessionId) args.push('--session-id', req.harnessSessionId);
  args.push('-');
  return args;
}

export function parseDsh(stdout: string, fallbackSessionId: string | null): { text: string; sessionId: string } {
  let sessionId = fallbackSessionId;
  let final: Record<string, any> | null = null;
  for (const e of jsonLines(stdout)) {
    if (typeof e.sessionId === 'string') sessionId = e.sessionId;
    if (e.type === 'final') final = e;
  }
  if (!final) throw new Error('no final event in dsh output');
  if (final.reason?.kind !== 'completed') {
    throw new Error(final.reason?.error?.message ?? `dsh turn ended with ${final.reason?.kind ?? 'unknown reason'}`);
  }
  if (!sessionId) throw new Error('no session id in dsh output');
  return { text: typeof final.text === 'string' ? final.text : '', sessionId };
}

export function dshModelPatch(provider: string, model: string): string {
  return [
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    `    provider: ${JSON.stringify(provider)}`,
    `    model: ${JSON.stringify(model)}`,
    '',
  ].join('\n');
}

export interface DshAdapterOptions {
  cmd?: string;
  /** Returns the path of a --patch overlay file, or null for none. */
  patchPath?: () => string | null;
}

export class DshAdapter implements AgentAdapter {
  readonly name = 'dsh';
  readonly displayName = 'DSH';
  readonly defaultBio = 'DeepSeek Harness 里的 DeepSeek 模型，回应快，擅长中文交流和快速给出思路。';
  private readonly cmd: string;
  private readonly patchPath: () => string | null;

  constructor(options: DshAdapterOptions = {}) {
    this.cmd = options.cmd ?? 'dsh';
    this.patchPath = options.patchPath ?? (() => null);
  }

  check(): Promise<Availability> {
    return checkCommand(this.cmd, 'DSH');
  }

  invoke(req: InvokeRequest): Promise<InvokeResult> {
    return invokeCli({ cmd: this.cmd, args: dshArgs(req, this.patchPath()), stdin: buildPrompt(req) }, req, parseDsh);
  }

  complete(req: CompleteRequest): Promise<string> {
    const args = dshArgs({ workdir: req.workdir, harnessSessionId: null }, this.patchPath());
    return completeCli({ cmd: this.cmd, args, stdin: req.prompt }, req, parseDsh);
  }
}
