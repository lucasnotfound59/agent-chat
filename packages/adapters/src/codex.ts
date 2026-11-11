import { checkCommand, invokeCli, jsonLines } from './cli';
import { buildPrompt } from './prompt';
import type { AgentAdapter, Availability, InvokeRequest, InvokeResult } from './types';

export function codexArgs(req: InvokeRequest): string[] {
  if (req.harnessSessionId) {
    return [
      'exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"',
      req.harnessSessionId, '-',
    ];
  }
  return ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-C', req.workdir, '-'];
}

export function parseCodex(stdout: string, fallbackSessionId: string | null): { text: string; sessionId: string } {
  let sessionId = fallbackSessionId;
  let text = '';
  for (const e of jsonLines(stdout)) {
    if (e.type === 'thread.started' && typeof e.thread_id === 'string') sessionId = e.thread_id;
    if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') {
      text = e.item.text;
    }
  }
  if (!text) throw new Error('no agent message in codex output');
  if (!sessionId) throw new Error('no session id in codex output');
  return { text, sessionId };
}

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  readonly displayName = 'Codex';
  readonly defaultBio = 'OpenAI 的编程 agent，擅长读代码、定位问题和给出具体实现方案。';

  constructor(private readonly cmd = 'codex') {}

  check(): Promise<Availability> {
    return checkCommand(this.cmd, 'Codex');
  }

  invoke(req: InvokeRequest): Promise<InvokeResult> {
    return invokeCli({ cmd: this.cmd, args: codexArgs(req), stdin: buildPrompt(req) }, req, parseCodex);
  }
}
