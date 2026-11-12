import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCommand, completeCli, invokeCli, jsonLines } from './cli';
import { buildPrompt } from './prompt';
import type { AgentAdapter, ArgsRequest, Availability, CompleteRequest, InvokeRequest, InvokeResult } from './types';

export const OPENCODE_AGENT_NAME = 'agentchat';

/** Config for a chat-only agent. The built-in `plan` agent still allows shell, so we define our own. */
export function opencodeConfigContent(): string {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    agent: {
      [OPENCODE_AGENT_NAME]: {
        mode: 'primary',
        description: 'Chat-only agent: may read and search, may not run commands or change files.',
        permission: {
          '*': 'deny',
          read: 'allow',
          grep: 'allow',
          glob: 'allow',
          webfetch: 'allow',
          websearch: 'allow',
        },
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Writes <workdir>/opencode.json (only there), restoring it if it differs. */
export function ensureOpenCodeConfig(workdir: string): void {
  mkdirSync(workdir, { recursive: true });
  const file = join(workdir, 'opencode.json');
  const want = opencodeConfigContent();
  let current: string | null = null;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // missing
  }
  if (current !== want) writeFileSync(file, want);
}

export function opencodeArgs(req: ArgsRequest, prompt: string): string[] {
  const args = ['run', '--format', 'json', '--agent', OPENCODE_AGENT_NAME];
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
    ensureOpenCodeConfig(req.workdir);
    return invokeCli({ cmd: this.cmd, args: opencodeArgs(req, buildPrompt(req)) }, req, parseOpenCode);
  }

  complete(req: CompleteRequest): Promise<string> {
    ensureOpenCodeConfig(req.workdir);
    const args = opencodeArgs({ workdir: req.workdir, harnessSessionId: null }, req.prompt);
    return completeCli({ cmd: this.cmd, args }, req, parseOpenCode);
  }
}
