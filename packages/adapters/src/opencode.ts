import { checkCommand, invokeCli, jsonLines } from './cli';
import { buildPrompt } from './prompt';
import type { AgentAdapter, Availability, InvokeRequest, InvokeResult } from './types';

export function opencodeArgs(req: InvokeRequest, prompt: string): string[] {
  const args = ['run', '--format', 'json', '--agent', 'plan'];
  if (req.harnessSessionId) args.push('--session', req.harnessSessionId);
  args.push(prompt);
  return args;
}

export function parseOpenCode(stdout: string, fallbackSessionId: string | null): { text: string; sessionId: string } {
  let sessionId = fallbackSessionId;
  let texts: string[] = [];
  for (const e of jsonLines(stdout)) {
    if (typeof e.sessionID === 'string') sessionId = e.sessionID;
    if (e.type === 'step_start') texts = [];
    if (e.type === 'text' && typeof e.part?.text === 'string') texts.push(e.part.text);
  }
  if (texts.length === 0) throw new Error('no text in opencode output');
  if (!sessionId) throw new Error('no session id in opencode output');
  return { text: texts.join('\n\n'), sessionId };
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode';
  readonly displayName = 'OpenCode';
  readonly defaultBio = '开源的编程 agent，可接多家模型，擅长代码相关的讨论和方案比较。';

  constructor(private readonly cmd = 'opencode') {}

  check(): Promise<Availability> {
    return checkCommand(this.cmd, 'OpenCode');
  }

  invoke(req: InvokeRequest): Promise<InvokeResult> {
    return invokeCli({ cmd: this.cmd, args: opencodeArgs(req, buildPrompt(req)) }, req, parseOpenCode);
  }
}
