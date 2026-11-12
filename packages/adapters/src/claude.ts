import { completeCli, invokeCli, jsonLines } from './cli';
import { buildPrompt } from './prompt';
import { runProcess } from './runProcess';
import type { AgentAdapter, ArgsRequest, Availability, CompleteRequest, InvokeRequest, InvokeResult } from './types';

const TOOLS = 'Read,WebSearch,WebFetch';

export function claudeArgs(req: ArgsRequest): string[] {
  const args = ['-p', '--output-format', 'json', '--tools', TOOLS, '--allowedTools', TOOLS, '--strict-mcp-config'];
  if (req.harnessSessionId) args.push('--resume', req.harnessSessionId);
  return args;
}

export function parseClaude(stdout: string, fallbackSessionId: string | null): { text: string; sessionId: string } {
  const result = jsonLines(stdout)
    .reverse()
    .find((e) => e.type === 'result');
  if (!result) throw new Error('no result object in claude output');
  if (result.is_error) throw new Error(typeof result.result === 'string' ? result.result : 'claude reported an error');
  const sessionId = typeof result.session_id === 'string' ? result.session_id : fallbackSessionId;
  if (!sessionId) throw new Error('no session id in claude output');
  return { text: typeof result.result === 'string' ? result.result : '', sessionId };
}

export function parseClaudeAuth(stdout: string): Availability {
  const notLoggedIn = { ok: false, reason: 'Claude Code 未登录：请在终端运行 claude 并执行 /login' };
  try {
    const status = JSON.parse(stdout);
    return status.loggedIn === true ? { ok: true } : notLoggedIn;
  } catch {
    return notLoggedIn;
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude';
  readonly displayName = 'Claude Code';
  readonly defaultBio = 'Anthropic 的 Claude，擅长代码、写作和细致的分析推理。';

  constructor(private readonly cmd = 'claude') {}

  async check(): Promise<Availability> {
    try {
      const r = await runProcess({
        cmd: this.cmd,
        args: ['auth', 'status'],
        cwd: process.cwd(),
        signal: new AbortController().signal,
        timeoutMs: 15000,
      });
      return parseClaudeAuth(r.stdout);
    } catch {
      return { ok: false, reason: `未找到 Claude Code 的命令 ${this.cmd}` };
    }
  }

  invoke(req: InvokeRequest): Promise<InvokeResult> {
    return invokeCli({ cmd: this.cmd, args: claudeArgs(req), stdin: buildPrompt(req) }, req, parseClaude);
  }

  complete(req: CompleteRequest): Promise<string> {
    const args = claudeArgs({ workdir: req.workdir, harnessSessionId: null });
    return completeCli({ cmd: this.cmd, args, stdin: req.prompt }, req, parseClaude);
  }
}
