# Agent Chat 第一期 A：后端（中枢、调度器、四个适配器）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个本机后台服务，人通过 HTTP/WebSocket 与 Claude Code、Codex、OpenCode、DSH 四个常驻联系人私聊和群聊，群聊中 agent 自由发言并受轮数、每日次数、暂停、全局停止约束。

**Architecture:** npm workspaces 仓库，两个包：`packages/adapters`（统一的 agent 适配器接口，每个 harness 一个实现，外加假适配器）和 `packages/hub`（SQLite 存储、调度器、点名模型、Fastify HTTP/WebSocket 接口）。中枢只认"成员"和"消息"，通过适配器接口唤起 agent。网页界面是下一份计划（第一期 B），本计划完成后可用 HTTP 接口和冒烟脚本完整验证。

**Tech Stack:** Node 24、TypeScript 5、`node:sqlite`（内置，无原生依赖，便于以后打包）、Fastify 5、`@fastify/websocket` 11、Vitest 2、tsx。

## Global Constraints

- 规格文档：`docs/superpowers/specs/2026-11-11-agent-chat-phase1-design.md`。
- Node ≥ 22.13；本机为 24.14.0。
- 中枢只监听 `127.0.0.1`；所有 HTTP 请求须带 `Authorization: Bearer <token>`。
- 数据目录默认 `~/Library/Application Support/AgentChat/`，可用环境变量 `AGENTCHAT_DATA_DIR` 覆盖；测试一律用临时目录或 `:memory:`。
- `config.json` 权限 `0600`；应用不读取其他工具已有的密钥。
- 聊天中的 agent 一律只读运行，工作目录为 `<数据目录>/workspaces/<适配器名>/`。
- 默认值：合并等待 3000 毫秒、连续 agent 轮数上限 6、每群每日唤起上限 200、单次唤起超时 300000 毫秒、会话失效时补最近 30 条。
- 自动测试不得调用真实 agent 或真实网络；真实 agent 只在 Task 12 的手动冒烟脚本中调用。
- "不开口"标记固定为 `[[PASS]]`。
- 已在本机实测的命令行（2026-11-11）：
  - Codex 0.167.0：新会话 `codex exec --json --skip-git-repo-check -s read-only -C <dir> -`；续接 `codex exec resume --json --skip-git-repo-check -c sandbox_mode="read-only" <id> -`（`resume` 不接受 `-s`）。
  - OpenCode 2.2.6：`opencode run --format json --agent plan [--session <id>] <消息>`。
  - DSH 0.2.2-rc.1：`dsh --profile headless [--patch <文件>] --json --permission-mode read-only --approval-policy never [--session-id <id>] -`。本机 headless 配置的默认模型指向未注册的 provider，必须用 `--patch` 覆盖为 `my-provider` / `my-provider/deepseek-flash` 才能运行。
  - Claude Code 2.1.322：`claude -p --output-format json --tools Read,WebSearch,WebFetch --allowedTools Read,WebSearch,WebFetch --strict-mcp-config [--resume <id>]`，提示词走标准输入。本机命令行当前未登录（`claude auth status` 返回 `loggedIn: false`），成功输出格式未实测，只确认了 `{type:"result", is_error, result, session_id}` 这几个字段。

## File Structure

```
package.json                      workspaces、脚本、开发依赖
tsconfig.json
.gitignore
packages/adapters/
  package.json
  src/types.ts                    AgentAdapter 接口、InvokeRequest/Result、AdapterError
  src/prompt.ts                   buildPrompt、toResult、PASS_TOKEN
  src/runProcess.ts               子进程封装：超时、中止、按行回调
  src/cli.ts                      jsonLines、invokeCli、checkCommand
  src/fake.ts                     FakeAdapter
  src/codex.ts  src/opencode.ts  src/dsh.ts  src/claude.ts
  src/index.ts                    统一导出
  test/*.test.ts
packages/hub/
  package.json
  src/types.ts                    Member、Conversation、Message、Settings、HubEvent
  src/config.ts                   ConfigStore
  src/store.ts                    Store（node:sqlite）
  src/mentions.ts                 parseMentions
  src/triage.ts                   Triage 接口、OpenAITriage、parseSpeakers
  src/scheduler.ts                Scheduler
  src/bootstrap.ts                首次启动的种子数据
  src/server.ts                   buildServer（Fastify 路由和 WebSocket）
  src/main.ts                     进程入口
  scripts/smoke.ts                真实 agent 手动冒烟
  test/*.test.ts
```

---

### Task 1: 仓库脚手架、适配器接口、提示词、假适配器

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `packages/adapters/package.json`, `packages/adapters/src/types.ts`, `packages/adapters/src/prompt.ts`, `packages/adapters/src/fake.ts`, `packages/adapters/src/index.ts`
- Test: `packages/adapters/test/prompt.test.ts`

**Interfaces:**
- Produces: `AgentAdapter`, `InvokeRequest`, `InvokeResult`, `ChatMessage`, `Availability`, `AdapterError`, `AdapterErrorCode`, `PASS_TOKEN`, `buildPrompt(req)`, `toResult(text, sessionId, isGroup)`, `FakeAdapter`。

- [ ] **Step 1: 写根配置**

`package.json`:
```json
{
  "name": "agent-chat",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=22.13" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "hub": "tsx packages/hub/src/main.ts",
    "smoke": "tsx packages/hub/scripts/smoke.ts"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["packages/*/src", "packages/*/test", "packages/*/scripts"]
}
```

`.gitignore`:
```
node_modules/
dist/
*.log
```

`packages/adapters/package.json`:
```json
{
  "name": "@agent-chat/adapters",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts"
}
```

- [ ] **Step 2: 写失败的测试**

`packages/adapters/test/prompt.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildPrompt, toResult, PASS_TOKEN, FakeAdapter, AdapterError } from '../src/index';
import type { InvokeRequest } from '../src/index';

const base: InvokeRequest = {
  conversationId: 'c1',
  agentName: 'Codex',
  conversationTitle: '闲聊群',
  isGroup: true,
  harnessSessionId: null,
  newMessages: [
    { id: 'm1', senderName: '小明', body: '大家好', createdAt: 0, attachments: [] },
    { id: 'm2', senderName: 'Claude Code', body: '你好', createdAt: 0, attachments: ['/w/a.png'] },
  ],
  workdir: '/w',
  signal: new AbortController().signal,
  timeoutMs: 1000,
};

describe('buildPrompt', () => {
  it('includes identity, messages, attachments and the pass rule in groups', () => {
    const p = buildPrompt(base);
    expect(p).toContain('You are "Codex"');
    expect(p).toContain('group chat "闲聊群"');
    expect(p).toContain('小明: 大家好');
    expect(p).toContain('Claude Code: 你好');
    expect(p).toContain('/w/a.png');
    expect(p).toContain(PASS_TOKEN);
  });

  it('omits the pass rule in private chats', () => {
    const p = buildPrompt({ ...base, isGroup: false });
    expect(p).toContain('a private chat');
    expect(p).not.toContain(PASS_TOKEN);
  });
});

describe('toResult', () => {
  it('returns a reply for normal text', () => {
    expect(toResult('  hi  ', 's1', true)).toEqual({ kind: 'reply', body: 'hi', harnessSessionId: 's1' });
  });
  it('returns silent for the pass token in a group', () => {
    expect(toResult(` ${PASS_TOKEN}\n`, 's1', true)).toEqual({ kind: 'silent', harnessSessionId: 's1' });
  });
  it('treats the pass token as a reply in a private chat', () => {
    expect(toResult(PASS_TOKEN, 's1', false).kind).toBe('reply');
  });
  it('throws crashed on empty text', () => {
    expect(() => toResult('   ', 's1', true)).toThrow(AdapterError);
  });
});

describe('FakeAdapter', () => {
  it('records calls and returns the scripted result', async () => {
    const a = new FakeAdapter('fake-a', 'A');
    const r = await a.invoke(base);
    expect(r).toEqual({ kind: 'reply', body: 'reply from A', harnessSessionId: 'fake-a-session' });
    expect(a.calls).toHaveLength(1);
    a.handler = async () => ({ kind: 'silent', harnessSessionId: 'x' });
    expect((await a.invoke(base)).kind).toBe('silent');
  });
});
```

- [ ] **Step 3: 安装依赖并确认测试失败**

Run: `npm install && npx vitest run packages/adapters/test/prompt.test.ts`
Expected: FAIL，报找不到 `../src/index`。

- [ ] **Step 4: 实现**

`packages/adapters/src/types.ts`:
```ts
export interface ChatMessage {
  id: string;
  senderName: string;
  body: string;
  createdAt: number;
  /** Absolute paths readable from the agent's workdir. */
  attachments: string[];
}

export interface InvokeRequest {
  conversationId: string;
  agentName: string;
  conversationTitle: string;
  isGroup: boolean;
  /** null means start a fresh harness session. */
  harnessSessionId: string | null;
  newMessages: ChatMessage[];
  workdir: string;
  signal: AbortSignal;
  timeoutMs: number;
  onTyping?: () => void;
}

export type InvokeResult =
  | { kind: 'reply'; body: string; harnessSessionId: string }
  | { kind: 'silent'; harnessSessionId: string };

export interface Availability {
  ok: boolean;
  reason?: string;
}

export interface AgentAdapter {
  /** Stable identifier, also the workspace directory name. */
  readonly name: string;
  readonly displayName: string;
  readonly defaultBio: string;
  check(): Promise<Availability>;
  invoke(req: InvokeRequest): Promise<InvokeResult>;
}

export type AdapterErrorCode = 'timeout' | 'aborted' | 'crashed' | 'unavailable';

export class AdapterError extends Error {
  constructor(public readonly code: AdapterErrorCode, message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}
```

`packages/adapters/src/prompt.ts`:
```ts
import { AdapterError } from './types';
import type { InvokeRequest, InvokeResult } from './types';

export const PASS_TOKEN = '[[PASS]]';

export function buildPrompt(req: InvokeRequest): string {
  const where = req.isGroup ? `the group chat "${req.conversationTitle}"` : 'a private chat';
  const lines = req.newMessages.map((m) => {
    const time = new Date(m.createdAt).toTimeString().slice(0, 5);
    const att = m.attachments.length ? `\n  (attachments: ${m.attachments.join(', ')})` : '';
    return `[${time}] ${m.senderName}: ${m.body}${att}`;
  });
  const parts = [
    `[Agent Chat] You are "${req.agentName}", a member of ${where} in a chat app.`,
    'The other members are a human and other AI agents. You are here to talk, not to do work: do not create or modify files.',
    '',
    'New messages since you last looked:',
    lines.length ? lines.join('\n') : '(no new messages)',
    '',
    'Write only the text of your chat message, in the language the conversation is using. To address someone, write @ followed by their exact name.',
  ];
  if (req.isGroup) {
    parts.push(`If you have nothing useful to add, reply with exactly ${PASS_TOKEN} and nothing else.`);
  }
  return parts.join('\n');
}

export function toResult(text: string, harnessSessionId: string, isGroup: boolean): InvokeResult {
  const body = text.trim();
  if (!body) throw new AdapterError('crashed', 'agent returned empty text');
  if (isGroup && body === PASS_TOKEN) return { kind: 'silent', harnessSessionId };
  return { kind: 'reply', body, harnessSessionId };
}
```

`packages/adapters/src/fake.ts`:
```ts
import type { AgentAdapter, Availability, InvokeRequest, InvokeResult } from './types';

export class FakeAdapter implements AgentAdapter {
  readonly defaultBio = 'fake agent for tests';
  calls: InvokeRequest[] = [];
  availability: Availability = { ok: true };
  handler: (req: InvokeRequest) => Promise<InvokeResult>;

  constructor(public readonly name: string, public readonly displayName: string) {
    this.handler = async () => ({
      kind: 'reply',
      body: `reply from ${displayName}`,
      harnessSessionId: `${name}-session`,
    });
  }

  async check(): Promise<Availability> {
    return this.availability;
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    this.calls.push(req);
    return this.handler(req);
  }
}
```

`packages/adapters/src/index.ts`:
```ts
export * from './types';
export * from './prompt';
export * from './fake';
```

- [ ] **Step 5: 确认测试通过**

Run: `npx vitest run packages/adapters/test/prompt.test.ts && npm run typecheck`
Expected: 7 个测试 PASS，typecheck 无输出。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore packages/adapters
git commit -m "feat(adapters): adapter interface, prompt builder, fake adapter"
```

---

### Task 2: 子进程封装与命令行公共函数

**Files:**
- Create: `packages/adapters/src/runProcess.ts`, `packages/adapters/src/cli.ts`
- Modify: `packages/adapters/src/index.ts`
- Test: `packages/adapters/test/runProcess.test.ts`

**Interfaces:**
- Consumes: `AdapterError`, `InvokeRequest`, `InvokeResult`, `Availability`, `toResult`。
- Produces:
  - `runProcess(o: RunOptions): Promise<RunResult>`，`RunOptions = { cmd, args, cwd, stdin?, signal, timeoutMs, env? }`，`RunResult = { code: number | null, stdout: string, stderr: string }`；超时抛 `AdapterError('timeout')`，中止抛 `AdapterError('aborted')`，命令不存在抛 `AdapterError('unavailable')`。
  - `jsonLines(stdout: string): Record<string, any>[]`
  - `invokeCli(spec: { cmd: string; args: string[]; stdin?: string }, req: InvokeRequest, parse: (stdout: string, fallbackSessionId: string | null) => { text: string; sessionId: string }): Promise<InvokeResult>`
  - `checkCommand(cmd: string, label: string): Promise<Availability>`

- [ ] **Step 1: 写失败的测试**

`packages/adapters/test/runProcess.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { runProcess, jsonLines, invokeCli, checkCommand, AdapterError } from '../src/index';
import type { InvokeRequest } from '../src/index';

const node = process.execPath;
const opts = (code: string, extra: Partial<Parameters<typeof runProcess>[0]> = {}) => ({
  cmd: node,
  args: ['-e', code],
  cwd: tmpdir(),
  signal: new AbortController().signal,
  timeoutMs: 5000,
  ...extra,
});

describe('runProcess', () => {
  it('captures stdout, stderr and exit code, and passes stdin', async () => {
    const r = await runProcess(
      opts(`process.stdin.on('data', d => { console.log('got ' + d); console.error('warn'); process.exitCode = 3; })`, {
        stdin: 'hello',
      }),
    );
    expect(r.stdout.trim()).toBe('got hello');
    expect(r.stderr.trim()).toBe('warn');
    expect(r.code).toBe(3);
  });

  it('rejects with timeout', async () => {
    await expect(runProcess(opts('setTimeout(() => {}, 10000)', { timeoutMs: 100 }))).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('rejects with aborted when the signal fires', async () => {
    const ac = new AbortController();
    const p = runProcess(opts('setTimeout(() => {}, 10000)', { signal: ac.signal }));
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
  });

  it('rejects with unavailable when the command does not exist', async () => {
    await expect(runProcess({ ...opts(''), cmd: 'definitely-not-a-command-xyz' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('jsonLines', () => {
  it('parses JSON lines and skips everything else', () => {
    expect(jsonLines('{"a":1}\nnot json\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('invokeCli', () => {
  const req: InvokeRequest = {
    conversationId: 'c',
    agentName: 'A',
    conversationTitle: 't',
    isGroup: true,
    harnessSessionId: 'old',
    newMessages: [],
    workdir: tmpdir(),
    signal: new AbortController().signal,
    timeoutMs: 5000,
  };

  it('runs the command, parses output and reports typing', async () => {
    let typed = 0;
    const r = await invokeCli(
      { cmd: node, args: ['-e', `console.log(JSON.stringify({text:'hi',sid:'s9'}))`] },
      { ...req, onTyping: () => typed++ },
      (stdout) => {
        const e = jsonLines(stdout)[0];
        return { text: e.text, sessionId: e.sid };
      },
    );
    expect(r).toEqual({ kind: 'reply', body: 'hi', harnessSessionId: 's9' });
    expect(typed).toBe(1);
  });

  it('wraps parse failures as crashed with stderr tail', async () => {
    const p = invokeCli({ cmd: node, args: ['-e', `console.error('boom'); process.exit(2)`] }, req, () => {
      throw new Error('no output');
    });
    await expect(p).rejects.toBeInstanceOf(AdapterError);
    await expect(p).rejects.toMatchObject({ code: 'crashed' });
    await expect(p).rejects.toThrow(/no output.*exit 2.*boom/s);
  });
});

describe('checkCommand', () => {
  it('is ok for an existing command and explains a missing one', async () => {
    expect(await checkCommand(node, 'Node')).toEqual({ ok: true });
    const bad = await checkCommand('definitely-not-a-command-xyz', 'Xyz');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('Xyz');
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run packages/adapters/test/runProcess.test.ts`
Expected: FAIL，`runProcess` 未导出。

- [ ] **Step 3: 实现**

`packages/adapters/src/runProcess.ts`:
```ts
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
```

`packages/adapters/src/cli.ts`:
```ts
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
```

在 `packages/adapters/src/index.ts` 末尾追加：
```ts
export * from './runProcess';
export * from './cli';
```

- [ ] **Step 4: 确认通过**

Run: `npx vitest run packages/adapters/test/runProcess.test.ts && npm run typecheck`
Expected: 8 个测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/adapters
git commit -m "feat(adapters): subprocess runner and CLI helpers"
```

---

### Task 3: Codex 适配器

**Files:**
- Create: `packages/adapters/src/codex.ts`
- Modify: `packages/adapters/src/index.ts`
- Test: `packages/adapters/test/codex.test.ts`

**Interfaces:**
- Consumes: `invokeCli`, `checkCommand`, `jsonLines`, `buildPrompt`, `AgentAdapter`, `InvokeRequest`。
- Produces: `CodexAdapter`（`name = 'codex'`）、`codexArgs(req: InvokeRequest): string[]`、`parseCodex(stdout, fallbackSessionId)`。

- [ ] **Step 1: 写失败的测试**（事件流取自本机实测输出）

`packages/adapters/test/codex.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { codexArgs, parseCodex, CodexAdapter } from '../src/index';
import type { InvokeRequest } from '../src/index';

const req: InvokeRequest = {
  conversationId: 'c',
  agentName: 'Codex',
  conversationTitle: 't',
  isGroup: false,
  harnessSessionId: null,
  newMessages: [],
  workdir: '/data/workspaces/codex',
  signal: new AbortController().signal,
  timeoutMs: 1000,
};

const OK = [
  '{"type":"thread.started","thread_id":"01a1c958-fbff-7b70-84bd-9647eb7f1ae4"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"thinking out loud"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"pong"}}',
  '{"type":"turn.completed","usage":{"input_tokens":24088,"output_tokens":5}}',
].join('\n');

describe('codexArgs', () => {
  it('starts a read-only session in the workdir', () => {
    expect(codexArgs(req)).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-C', '/data/workspaces/codex', '-',
    ]);
  });
  it('resumes with the sandbox set through config', () => {
    expect(codexArgs({ ...req, harnessSessionId: 'abc' })).toEqual([
      'exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', 'abc', '-',
    ]);
  });
});

describe('parseCodex', () => {
  it('takes the thread id and the last agent message', () => {
    expect(parseCodex(OK, null)).toEqual({ text: 'pong', sessionId: '01a1c958-fbff-7b70-84bd-9647eb7f1ae4' });
  });
  it('falls back to the known session id when none is emitted', () => {
    const noThread = OK.split('\n').slice(1).join('\n');
    expect(parseCodex(noThread, 'known').sessionId).toBe('known');
  });
  it('throws when there is no agent message', () => {
    expect(() => parseCodex('{"type":"thread.started","thread_id":"x"}\n', null)).toThrow(/no agent message/);
  });
  it('throws when there is no session id at all', () => {
    expect(() => parseCodex('{"type":"item.completed","item":{"type":"agent_message","text":"x"}}', null)).toThrow(
      /no session id/,
    );
  });
});

describe('CodexAdapter', () => {
  it('has stable identity', () => {
    const a = new CodexAdapter();
    expect(a.name).toBe('codex');
    expect(a.displayName).toBe('Codex');
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run packages/adapters/test/codex.test.ts`
Expected: FAIL，`codexArgs` 未导出。

- [ ] **Step 3: 实现**

`packages/adapters/src/codex.ts`:
```ts
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
```

在 `packages/adapters/src/index.ts` 末尾追加 `export * from './codex';`。

- [ ] **Step 4: 确认通过**

Run: `npx vitest run packages/adapters/test/codex.test.ts && npm run typecheck`
Expected: 7 个测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/adapters
git commit -m "feat(adapters): Codex adapter"
```

---

### Task 4: OpenCode 适配器

**Files:**
- Create: `packages/adapters/src/opencode.ts`
- Modify: `packages/adapters/src/index.ts`
- Test: `packages/adapters/test/opencode.test.ts`

**Interfaces:**
- Consumes: 同 Task 3。
- Produces: `OpenCodeAdapter`（`name = 'opencode'`）、`opencodeArgs(req, prompt): string[]`、`parseOpenCode(stdout, fallbackSessionId)`。

- [ ] **Step 1: 写失败的测试**（事件流取自本机实测输出）

`packages/adapters/test/opencode.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { opencodeArgs, parseOpenCode, OpenCodeAdapter } from '../src/index';
import type { InvokeRequest } from '../src/index';

const req: InvokeRequest = {
  conversationId: 'c',
  agentName: 'OpenCode',
  conversationTitle: 't',
  isGroup: false,
  harnessSessionId: null,
  newMessages: [],
  workdir: '/w',
  signal: new AbortController().signal,
  timeoutMs: 1000,
};

const sid = 'ses_e36a6f745ffetZxOQMlP3EF8dd';
const ev = (type: string, part: object) => JSON.stringify({ type, timestamp: 1, sessionID: sid, part });
const OK = [
  ev('step_start', { type: 'step-start' }),
  ev('text', { type: 'text', text: 'let me look' }),
  ev('step_finish', { type: 'step-finish', reason: 'tool-calls' }),
  ev('step_start', { type: 'step-start' }),
  ev('text', { type: 'text', text: 'first part' }),
  ev('text', { type: 'text', text: 'second part' }),
  ev('step_finish', { type: 'step-finish', reason: 'stop' }),
].join('\n');

describe('opencodeArgs', () => {
  it('uses the read-only plan agent and passes the prompt as the message', () => {
    expect(opencodeArgs(req, 'PROMPT')).toEqual(['run', '--format', 'json', '--agent', 'plan', 'PROMPT']);
  });
  it('adds the session when resuming', () => {
    expect(opencodeArgs({ ...req, harnessSessionId: sid }, 'PROMPT')).toEqual([
      'run', '--format', 'json', '--agent', 'plan', '--session', sid, 'PROMPT',
    ]);
  });
});

describe('parseOpenCode', () => {
  it('joins the text parts of the final step', () => {
    expect(parseOpenCode(OK, null)).toEqual({ text: 'first part\n\nsecond part', sessionId: sid });
  });
  it('throws when there is no text', () => {
    expect(() => parseOpenCode(ev('step_start', {}), null)).toThrow(/no text/);
  });
  it('throws when there is no session id', () => {
    expect(() => parseOpenCode('{"type":"text","part":{"type":"text","text":"x"}}', null)).toThrow(/no session id/);
  });
});

describe('OpenCodeAdapter', () => {
  it('has stable identity', () => {
    expect(new OpenCodeAdapter().name).toBe('opencode');
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run packages/adapters/test/opencode.test.ts`
Expected: FAIL，`opencodeArgs` 未导出。

- [ ] **Step 3: 实现**

`packages/adapters/src/opencode.ts`:
```ts
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
```

在 `packages/adapters/src/index.ts` 末尾追加 `export * from './opencode';`。

- [ ] **Step 4: 确认通过**

Run: `npx vitest run packages/adapters/test/opencode.test.ts && npm run typecheck`
Expected: 6 个测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/adapters
git commit -m "feat(adapters): OpenCode adapter"
```

---

### Task 5: DSH 适配器

**Files:**
- Create: `packages/adapters/src/dsh.ts`
- Modify: `packages/adapters/src/index.ts`
- Test: `packages/adapters/test/dsh.test.ts`

**Interfaces:**
- Consumes: 同 Task 3。
- Produces: `DshAdapter`（`name = 'dsh'`，构造参数 `{ cmd?: string; patchPath?: () => string | null }`）、`dshArgs(req, patchPath: string | null): string[]`、`parseDsh(stdout, fallbackSessionId)`、`dshModelPatch(provider: string, model: string): string`（生成 `--patch` 文件内容）。

- [ ] **Step 1: 写失败的测试**（事件流取自本机实测输出）

`packages/adapters/test/dsh.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { dshArgs, parseDsh, dshModelPatch, DshAdapter } from '../src/index';
import type { InvokeRequest } from '../src/index';

const req: InvokeRequest = {
  conversationId: 'c',
  agentName: 'DSH',
  conversationTitle: 't',
  isGroup: false,
  harnessSessionId: null,
  newMessages: [],
  workdir: '/w',
  signal: new AbortController().signal,
  timeoutMs: 1000,
};

const sid = 'session-fead01dc-7569-438c-93d2-70e840639732';
const OK = [
  `{"type":"session","sessionId":"${sid}","cwd":"/w"}`,
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"text","text":"pong"}',
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
  `{"type":"final","sessionId":"${sid}","reason":{"kind":"completed"},"text":"pong"}`,
].join('\n');
const FAIL = [
  `{"type":"session","sessionId":"${sid}","cwd":"/w"}`,
  `{"type":"final","sessionId":"${sid}","reason":{"kind":"error","error":{"message":"no adapter registered for provider \\"my-provider-responses\\"","code":"NO_ADAPTER"}},"text":""}`,
].join('\n');

describe('dshArgs', () => {
  it('runs headless, read-only, never asking', () => {
    expect(dshArgs(req, null)).toEqual([
      '--profile', 'headless', '--json', '--permission-mode', 'read-only', '--approval-policy', 'never', '-',
    ]);
  });
  it('adds the model patch and the session id', () => {
    expect(dshArgs({ ...req, harnessSessionId: sid }, '/data/dsh-model.patch.yml')).toEqual([
      '--profile', 'headless', '--patch', '/data/dsh-model.patch.yml', '--json',
      '--permission-mode', 'read-only', '--approval-policy', 'never', '--session-id', sid, '-',
    ]);
  });
});

describe('parseDsh', () => {
  it('reads the final text and session id', () => {
    expect(parseDsh(OK, null)).toEqual({ text: 'pong', sessionId: sid });
  });
  it('throws the harness error message on a failed turn', () => {
    expect(() => parseDsh(FAIL, null)).toThrow(/no adapter registered/);
  });
  it('throws when there is no final event', () => {
    expect(() => parseDsh(`{"type":"session","sessionId":"${sid}"}`, null)).toThrow(/no final event/);
  });
});

describe('dshModelPatch', () => {
  it('renders a patch entry for the default model plugin', () => {
    expect(dshModelPatch('my-provider', 'my-provider/deepseek-flash')).toBe(
      [
        '- id: agent-default-model',
        "  name: '@deepseek-ai/dsh-agent-default-model'",
        '  config:',
        '    provider: "my-provider"',
        '    model: "my-provider/deepseek-flash"',
        '',
      ].join('\n'),
    );
  });
});

describe('DshAdapter', () => {
  it('has stable identity', () => {
    expect(new DshAdapter().name).toBe('dsh');
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run packages/adapters/test/dsh.test.ts`
Expected: FAIL，`dshArgs` 未导出。

- [ ] **Step 3: 实现**

`packages/adapters/src/dsh.ts`:
```ts
import { checkCommand, invokeCli, jsonLines } from './cli';
import { buildPrompt } from './prompt';
import type { AgentAdapter, Availability, InvokeRequest, InvokeResult } from './types';

export function dshArgs(req: InvokeRequest, patchPath: string | null): string[] {
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
}
```

在 `packages/adapters/src/index.ts` 末尾追加 `export * from './dsh';`。

- [ ] **Step 4: 确认通过**

Run: `npx vitest run packages/adapters/test/dsh.test.ts && npm run typecheck`
Expected: 7 个测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/adapters
git commit -m "feat(adapters): DSH adapter with model patch overlay"
```

---

### Task 6: Claude Code 适配器

**Files:**
- Create: `packages/adapters/src/claude.ts`
- Modify: `packages/adapters/src/index.ts`
- Test: `packages/adapters/test/claude.test.ts`

**Interfaces:**
- Consumes: `runProcess`, `invokeCli`, `jsonLines`, `buildPrompt`。
- Produces: `ClaudeAdapter`（`name = 'claude'`）、`claudeArgs(req): string[]`、`parseClaude(stdout, fallbackSessionId)`、`parseClaudeAuth(stdout: string): Availability`。

- [ ] **Step 1: 写失败的测试**（失败样例取自本机实测输出；成功样例只使用已确认存在的字段）

`packages/adapters/test/claude.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { claudeArgs, parseClaude, parseClaudeAuth, ClaudeAdapter } from '../src/index';
import type { InvokeRequest } from '../src/index';

const req: InvokeRequest = {
  conversationId: 'c',
  agentName: 'Claude Code',
  conversationTitle: 't',
  isGroup: false,
  harnessSessionId: null,
  newMessages: [],
  workdir: '/w',
  signal: new AbortController().signal,
  timeoutMs: 1000,
};

const TOOLS = 'Read,WebSearch,WebFetch';

describe('claudeArgs', () => {
  it('prints JSON with only read and web tools', () => {
    expect(claudeArgs(req)).toEqual([
      '-p', '--output-format', 'json', '--tools', TOOLS, '--allowedTools', TOOLS, '--strict-mcp-config',
    ]);
  });
  it('resumes by session id', () => {
    expect(claudeArgs({ ...req, harnessSessionId: 'abc' })).toEqual([
      '-p', '--output-format', 'json', '--tools', TOOLS, '--allowedTools', TOOLS, '--strict-mcp-config',
      '--resume', 'abc',
    ]);
  });
});

describe('parseClaude', () => {
  it('reads result and session id', () => {
    const out = '{"type":"result","subtype":"success","is_error":false,"result":"pong","session_id":"e7cf2f38"}';
    expect(parseClaude(out, null)).toEqual({ text: 'pong', sessionId: 'e7cf2f38' });
  });
  it('throws the result text when is_error is true', () => {
    const out = '{"type":"result","is_error":true,"result":"Not logged in · Please run /login","session_id":"x"}';
    expect(() => parseClaude(out, null)).toThrow(/Not logged in/);
  });
  it('ignores warning lines before the JSON', () => {
    const out = 'Warning: something\n{"type":"result","is_error":false,"result":"hi","session_id":"s"}\n';
    expect(parseClaude(out, null).text).toBe('hi');
  });
  it('throws when there is no result object', () => {
    expect(() => parseClaude('garbage', null)).toThrow(/no result/);
  });
});

describe('parseClaudeAuth', () => {
  it('is ok when logged in', () => {
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai"}')).toEqual({ ok: true });
  });
  it('explains how to log in otherwise', () => {
    const a = parseClaudeAuth('{"loggedIn":false,"authMethod":"none"}');
    expect(a.ok).toBe(false);
    expect(a.reason).toContain('/login');
  });
  it('treats unparseable output as not logged in', () => {
    expect(parseClaudeAuth('???').ok).toBe(false);
  });
});

describe('ClaudeAdapter', () => {
  it('has stable identity', () => {
    expect(new ClaudeAdapter().name).toBe('claude');
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run packages/adapters/test/claude.test.ts`
Expected: FAIL，`claudeArgs` 未导出。

- [ ] **Step 3: 实现**

`packages/adapters/src/claude.ts`:
```ts
import { invokeCli, jsonLines } from './cli';
import { buildPrompt } from './prompt';
import { runProcess } from './runProcess';
import type { AgentAdapter, Availability, InvokeRequest, InvokeResult } from './types';

const TOOLS = 'Read,WebSearch,WebFetch';

export function claudeArgs(req: InvokeRequest): string[] {
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
}
```

在 `packages/adapters/src/index.ts` 末尾追加 `export * from './claude';`。

- [ ] **Step 4: 确认通过**

Run: `npx vitest run packages/adapters && npm run typecheck`
Expected: adapters 包全部测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/adapters
git commit -m "feat(adapters): Claude Code adapter"
```

---

### Task 7: 中枢类型、配置、存储

**Files:**
- Create: `packages/hub/package.json`, `packages/hub/src/types.ts`, `packages/hub/src/config.ts`, `packages/hub/src/store.ts`
- Test: `packages/hub/test/store.test.ts`, `packages/hub/test/config.test.ts`

**Interfaces:**
- Produces（`types.ts`）：
  ```ts
  type MemberKind = 'human' | 'agent';
  interface Member { id: string; kind: MemberKind; name: string; bio: string; adapter: string | null }
  interface Settings { debounceMs: number; maxAgentRounds: number; dailyInvocationCap: number; timeoutMs: number; paused: boolean }
  const DEFAULT_SETTINGS: Settings
  interface Conversation { id: string; kind: 'dm' | 'group'; title: string; settings: Settings; memberIds: string[]; createdAt: number }
  interface Attachment { name: string; file: string }   // file 相对于 <数据目录>/attachments
  interface Message { id: string; seq: number; conversationId: string; senderId: string | null; kind: 'normal' | 'system'; body: string; mentions: string[]; replyTo: string | null; attachments: Attachment[]; meta: Record<string, unknown> | null; createdAt: number }
  type Outcome = 'replied' | 'silent' | 'timeout' | 'error' | 'interrupted';
  interface Invocation { id: string; conversationId: string; memberId: string; reason: string; startedAt: number; endedAt: number | null; outcome: Outcome | null }
  type HubEvent =
    | { type: 'message'; message: Message }
    | { type: 'typing'; conversationId: string; memberId: string; active: boolean }
    | { type: 'conversation'; conversation: Conversation }
    | { type: 'stopped'; stopped: boolean };
  ```
- Produces（`store.ts`）：`class Store`，构造参数为数据库路径（`:memory:` 用于测试），方法：
  `createMember({kind,name,bio?,adapter?}): Member`、`listMembers(): Member[]`、`getMember(id): Member | null`、`updateMemberBio(id, bio): void`、
  `createConversation({kind,title,memberIds,settings?}): Conversation`、`listConversations(): Conversation[]`、`getConversation(id): Conversation | null`、`updateSettings(id, patch: Partial<Settings>): Conversation`、`listConversationMembers(id): Member[]`、
  `addMessage({conversationId, senderId, kind?, body, mentions?, replyTo?, attachments?, meta?}): Message`、`listMessages(conversationId, {beforeSeq?, limit?}): Message[]`（按 seq 升序，取最靠后的 limit 条，默认 50）、`listMessagesAfter(conversationId, seq): Message[]`、`maxSeq(conversationId): number`、
  `getAgentSession(conversationId, memberId): { harnessSessionId: string; lastSeenSeq: number } | null`、`setAgentSession(conversationId, memberId, harnessSessionId, lastSeenSeq): void`、`clearAgentSession(conversationId, memberId): void`、
  `startInvocation(conversationId, memberId, reason): string`、`finishInvocation(id, outcome): void`、`getInvocation(id): Invocation | null`、`countInvocationsSince(conversationId, sinceMs): number`、`markUnfinishedInterrupted(): number`。
- Produces（`config.ts`）：
  ```ts
  interface TriageConfig { baseUrl: string; apiKey: string; model: string }
  interface AppConfig { token: string; triage: TriageConfig | null; dsh: { provider: string; model: string } | null }
  class ConfigStore { constructor(dataDir: string); get(): AppConfig; update(patch: Partial<Omit<AppConfig, 'token'>>): AppConfig; readonly dataDir: string }
  ```

- [ ] **Step 1: 包配置**

`packages/hub/package.json`:
```json
{
  "name": "@agent-chat/hub",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@agent-chat/adapters": "*",
    "@fastify/websocket": "^11.0.0",
    "fastify": "^5.0.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.0",
    "ws": "^8.18.0"
  }
}
```

Run: `npm install`

- [ ] **Step 2: 写失败的测试**

`packages/hub/test/store.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import { DEFAULT_SETTINGS } from '../src/types';

let store: Store;
let human: string, a: string, b: string, group: string;

beforeEach(() => {
  store = new Store(':memory:');
  human = store.createMember({ kind: 'human', name: '我' }).id;
  a = store.createMember({ kind: 'agent', name: 'A', bio: 'agent a', adapter: 'fake-a' }).id;
  b = store.createMember({ kind: 'agent', name: 'B', adapter: 'fake-b' }).id;
  group = store.createConversation({ kind: 'group', title: 'G', memberIds: [human, a, b] }).id;
});

describe('members', () => {
  it('creates, lists, gets and updates bio', () => {
    expect(store.listMembers().map((m) => m.name)).toEqual(['我', 'A', 'B']);
    expect(store.getMember(a)).toMatchObject({ kind: 'agent', bio: 'agent a', adapter: 'fake-a' });
    expect(store.getMember('nope')).toBeNull();
    store.updateMemberBio(a, 'new bio');
    expect(store.getMember(a)!.bio).toBe('new bio');
  });
});

describe('conversations', () => {
  it('stores members and default settings', () => {
    const c = store.getConversation(group)!;
    expect(c.settings).toEqual(DEFAULT_SETTINGS);
    expect(c.memberIds.sort()).toEqual([human, a, b].sort());
    expect(store.listConversationMembers(group).map((m) => m.name).sort()).toEqual(['A', 'B', '我']);
    expect(store.listConversations()).toHaveLength(1);
    expect(store.getConversation('nope')).toBeNull();
  });
  it('merges settings patches', () => {
    const c = store.updateSettings(group, { paused: true, maxAgentRounds: 2 });
    expect(c.settings).toEqual({ ...DEFAULT_SETTINGS, paused: true, maxAgentRounds: 2 });
    expect(store.getConversation(group)!.settings.paused).toBe(true);
  });
});

describe('messages', () => {
  it('assigns increasing seq and round-trips all fields', () => {
    const m1 = store.addMessage({ conversationId: group, senderId: human, body: 'hi @A', mentions: [a] });
    const m2 = store.addMessage({
      conversationId: group,
      senderId: null,
      kind: 'system',
      body: 'note',
      meta: { invocationId: 'i1', retryable: true },
      attachments: [{ name: 'x.png', file: 'g/x.png' }],
      replyTo: m1.id,
    });
    expect(m2.seq).toBeGreaterThan(m1.seq);
    expect(m1).toMatchObject({ kind: 'normal', mentions: [a], attachments: [], meta: null, replyTo: null });
    const all = store.listMessages(group);
    expect(all.map((m) => m.id)).toEqual([m1.id, m2.id]);
    expect(all[1]).toEqual(m2);
  });
  it('pages backwards with beforeSeq and limit', () => {
    const ms = [1, 2, 3, 4, 5].map((i) => store.addMessage({ conversationId: group, senderId: human, body: `m${i}` }));
    expect(store.listMessages(group, { limit: 2 }).map((m) => m.body)).toEqual(['m4', 'm5']);
    expect(store.listMessages(group, { beforeSeq: ms[3].seq, limit: 2 }).map((m) => m.body)).toEqual(['m2', 'm3']);
  });
  it('lists messages after a seq and reports maxSeq', () => {
    expect(store.maxSeq(group)).toBe(0);
    const m1 = store.addMessage({ conversationId: group, senderId: human, body: 'one' });
    const m2 = store.addMessage({ conversationId: group, senderId: a, body: 'two' });
    expect(store.listMessagesAfter(group, m1.seq).map((m) => m.body)).toEqual(['two']);
    expect(store.maxSeq(group)).toBe(m2.seq);
  });
});

describe('agent sessions', () => {
  it('sets, gets and clears', () => {
    expect(store.getAgentSession(group, a)).toBeNull();
    store.setAgentSession(group, a, 's1', 3);
    store.setAgentSession(group, a, 's2', 7);
    expect(store.getAgentSession(group, a)).toEqual({ harnessSessionId: 's2', lastSeenSeq: 7 });
    store.clearAgentSession(group, a);
    expect(store.getAgentSession(group, a)).toBeNull();
  });
});

describe('invocations', () => {
  it('tracks outcome, counts by time and marks unfinished ones', () => {
    const before = Date.now();
    const i1 = store.startInvocation(group, a, 'round');
    const i2 = store.startInvocation(group, b, 'round');
    store.finishInvocation(i1, 'replied');
    expect(store.getInvocation(i1)).toMatchObject({ memberId: a, outcome: 'replied', reason: 'round' });
    expect(store.getInvocation(i1)!.endedAt).not.toBeNull();
    expect(store.countInvocationsSince(group, before)).toBe(2);
    expect(store.countInvocationsSince(group, Date.now() + 1000)).toBe(0);
    expect(store.markUnfinishedInterrupted()).toBe(1);
    expect(store.getInvocation(i2)!.outcome).toBe('interrupted');
  });
});
```

`packages/hub/test/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/config';

describe('ConfigStore', () => {
  it('creates a private config with a token and persists updates', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'agentchat-')), 'nested');
    const c1 = new ConfigStore(dir);
    const token = c1.get().token;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(c1.get().triage).toBeNull();
    expect(c1.get().dsh).toBeNull();
    expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);

    c1.update({ triage: { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' } });
    const c2 = new ConfigStore(dir);
    expect(c2.get().token).toBe(token);
    expect(c2.get().triage).toEqual({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' });
  });
});
```

- [ ] **Step 3: 确认失败**

Run: `npx vitest run packages/hub`
Expected: FAIL，找不到 `../src/store`。

- [ ] **Step 4: 实现**

`packages/hub/src/types.ts`:
```ts
export type MemberKind = 'human' | 'agent';

export interface Member {
  id: string;
  kind: MemberKind;
  name: string;
  bio: string;
  adapter: string | null;
}

export interface Settings {
  debounceMs: number;
  maxAgentRounds: number;
  dailyInvocationCap: number;
  timeoutMs: number;
  paused: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  debounceMs: 3000,
  maxAgentRounds: 6,
  dailyInvocationCap: 200,
  timeoutMs: 300000,
  paused: false,
};

export interface Conversation {
  id: string;
  kind: 'dm' | 'group';
  title: string;
  settings: Settings;
  memberIds: string[];
  createdAt: number;
}

export interface Attachment {
  name: string;
  /** Path relative to <dataDir>/attachments. */
  file: string;
}

export interface Message {
  id: string;
  seq: number;
  conversationId: string;
  senderId: string | null;
  kind: 'normal' | 'system';
  body: string;
  mentions: string[];
  replyTo: string | null;
  attachments: Attachment[];
  meta: Record<string, unknown> | null;
  createdAt: number;
}

export type Outcome = 'replied' | 'silent' | 'timeout' | 'error' | 'interrupted';

export interface Invocation {
  id: string;
  conversationId: string;
  memberId: string;
  reason: string;
  startedAt: number;
  endedAt: number | null;
  outcome: Outcome | null;
}

export type HubEvent =
  | { type: 'message'; message: Message }
  | { type: 'typing'; conversationId: string; memberId: string; active: boolean }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'stopped'; stopped: boolean };
```

`packages/hub/src/config.ts`:
```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export interface TriageConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AppConfig {
  token: string;
  triage: TriageConfig | null;
  dsh: { provider: string; model: string } | null;
}

export class ConfigStore {
  private readonly file: string;
  private config: AppConfig;

  constructor(public readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'config.json');
    if (existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      this.config = { token: raw.token, triage: raw.triage ?? null, dsh: raw.dsh ?? null };
    } else {
      this.config = { token: randomBytes(24).toString('hex'), triage: null, dsh: null };
      this.save();
    }
  }

  get(): AppConfig {
    return this.config;
  }

  update(patch: Partial<Omit<AppConfig, 'token'>>): AppConfig {
    this.config = { ...this.config, ...patch };
    this.save();
    return this.config;
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}
```

`packages/hub/src/store.ts`:
```ts
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS } from './types';
import type { Attachment, Conversation, Invocation, Member, MemberKind, Message, Outcome, Settings } from './types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE, bio TEXT NOT NULL, adapter TEXT);
CREATE TABLE IF NOT EXISTS conversations (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, title TEXT NOT NULL,
  settings TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (conversation_id, member_id));
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
  sender_id TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, mentions TEXT NOT NULL, reply_to TEXT,
  attachments TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, seq);
CREATE TABLE IF NOT EXISTS agent_sessions (
  conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, harness_session_id TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL, PRIMARY KEY (conversation_id, member_id));
CREATE TABLE IF NOT EXISTS invocations (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, reason TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT);
`;

type Row = Record<string, any>;

const toMember = (r: Row): Member => ({ id: r.id, kind: r.kind, name: r.name, bio: r.bio, adapter: r.adapter ?? null });

const toMessage = (r: Row): Message => ({
  id: r.id,
  seq: Number(r.seq),
  conversationId: r.conversation_id,
  senderId: r.sender_id ?? null,
  kind: r.kind,
  body: r.body,
  mentions: JSON.parse(r.mentions),
  replyTo: r.reply_to ?? null,
  attachments: JSON.parse(r.attachments),
  meta: r.meta ? JSON.parse(r.meta) : null,
  createdAt: Number(r.created_at),
});

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  createMember(input: { kind: MemberKind; name: string; bio?: string; adapter?: string | null }): Member {
    const m: Member = {
      id: randomUUID(),
      kind: input.kind,
      name: input.name,
      bio: input.bio ?? '',
      adapter: input.adapter ?? null,
    };
    this.db
      .prepare('INSERT INTO members (id, kind, name, bio, adapter) VALUES (?, ?, ?, ?, ?)')
      .run(m.id, m.kind, m.name, m.bio, m.adapter);
    return m;
  }

  listMembers(): Member[] {
    return this.db.prepare('SELECT * FROM members ORDER BY rowid').all().map(toMember);
  }

  getMember(id: string): Member | null {
    const r = this.db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    return r ? toMember(r) : null;
  }

  updateMemberBio(id: string, bio: string): void {
    this.db.prepare('UPDATE members SET bio = ? WHERE id = ?').run(bio, id);
  }

  createConversation(input: {
    kind: 'dm' | 'group';
    title: string;
    memberIds: string[];
    settings?: Partial<Settings>;
  }): Conversation {
    const c: Conversation = {
      id: randomUUID(),
      kind: input.kind,
      title: input.title,
      settings: { ...DEFAULT_SETTINGS, ...input.settings },
      memberIds: [...new Set(input.memberIds)],
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO conversations (id, kind, title, settings, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(c.id, c.kind, c.title, JSON.stringify(c.settings), c.createdAt);
    const add = this.db.prepare('INSERT INTO conversation_members (conversation_id, member_id) VALUES (?, ?)');
    for (const id of c.memberIds) add.run(c.id, id);
    return c;
  }

  private toConversation(r: Row): Conversation {
    const memberIds = this.db
      .prepare('SELECT member_id FROM conversation_members WHERE conversation_id = ?')
      .all(r.id)
      .map((x: Row) => x.member_id as string);
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      settings: { ...DEFAULT_SETTINGS, ...JSON.parse(r.settings) },
      memberIds,
      createdAt: Number(r.created_at),
    };
  }

  listConversations(): Conversation[] {
    return this.db
      .prepare('SELECT * FROM conversations ORDER BY rowid')
      .all()
      .map((r: Row) => this.toConversation(r));
  }

  getConversation(id: string): Conversation | null {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    return r ? this.toConversation(r) : null;
  }

  updateSettings(id: string, patch: Partial<Settings>): Conversation {
    const c = this.getConversation(id);
    if (!c) throw new Error(`unknown conversation ${id}`);
    const settings = { ...c.settings, ...patch };
    this.db.prepare('UPDATE conversations SET settings = ? WHERE id = ?').run(JSON.stringify(settings), id);
    return { ...c, settings };
  }

  listConversationMembers(id: string): Member[] {
    return this.db
      .prepare(
        'SELECT m.* FROM members m JOIN conversation_members cm ON cm.member_id = m.id WHERE cm.conversation_id = ? ORDER BY m.rowid',
      )
      .all(id)
      .map(toMember);
  }

  addMessage(input: {
    conversationId: string;
    senderId: string | null;
    kind?: 'normal' | 'system';
    body: string;
    mentions?: string[];
    replyTo?: string | null;
    attachments?: Attachment[];
    meta?: Record<string, unknown> | null;
  }): Message {
    const id = randomUUID();
    const createdAt = Date.now();
    const info = this.db
      .prepare(
        'INSERT INTO messages (id, conversation_id, sender_id, kind, body, mentions, reply_to, attachments, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.conversationId,
        input.senderId,
        input.kind ?? 'normal',
        input.body,
        JSON.stringify(input.mentions ?? []),
        input.replyTo ?? null,
        JSON.stringify(input.attachments ?? []),
        input.meta ? JSON.stringify(input.meta) : null,
        createdAt,
      );
    return {
      id,
      seq: Number(info.lastInsertRowid),
      conversationId: input.conversationId,
      senderId: input.senderId,
      kind: input.kind ?? 'normal',
      body: input.body,
      mentions: input.mentions ?? [],
      replyTo: input.replyTo ?? null,
      attachments: input.attachments ?? [],
      meta: input.meta ?? null,
      createdAt,
    };
  }

  listMessages(conversationId: string, opts: { beforeSeq?: number; limit?: number } = {}): Message[] {
    const limit = opts.limit ?? 50;
    const before = opts.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
      .all(conversationId, before, limit)
      .map(toMessage)
      .reverse();
  }

  listMessagesAfter(conversationId: string, seq: number): Message[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq')
      .all(conversationId, seq)
      .map(toMessage);
  }

  maxSeq(conversationId: string): number {
    const r = this.db.prepare('SELECT MAX(seq) AS s FROM messages WHERE conversation_id = ?').get(conversationId);
    return Number(r?.s ?? 0);
  }

  getAgentSession(conversationId: string, memberId: string): { harnessSessionId: string; lastSeenSeq: number } | null {
    const r = this.db
      .prepare('SELECT * FROM agent_sessions WHERE conversation_id = ? AND member_id = ?')
      .get(conversationId, memberId);
    return r ? { harnessSessionId: r.harness_session_id as string, lastSeenSeq: Number(r.last_seen_seq) } : null;
  }

  setAgentSession(conversationId: string, memberId: string, harnessSessionId: string, lastSeenSeq: number): void {
    this.db
      .prepare(
        'INSERT INTO agent_sessions (conversation_id, member_id, harness_session_id, last_seen_seq) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (conversation_id, member_id) DO UPDATE SET harness_session_id = excluded.harness_session_id, last_seen_seq = excluded.last_seen_seq',
      )
      .run(conversationId, memberId, harnessSessionId, lastSeenSeq);
  }

  clearAgentSession(conversationId: string, memberId: string): void {
    this.db
      .prepare('DELETE FROM agent_sessions WHERE conversation_id = ? AND member_id = ?')
      .run(conversationId, memberId);
  }

  startInvocation(conversationId: string, memberId: string, reason: string): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO invocations (id, conversation_id, member_id, reason, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, conversationId, memberId, reason, Date.now());
    return id;
  }

  finishInvocation(id: string, outcome: Outcome): void {
    this.db.prepare('UPDATE invocations SET ended_at = ?, outcome = ? WHERE id = ?').run(Date.now(), outcome, id);
  }

  getInvocation(id: string): Invocation | null {
    const r = this.db.prepare('SELECT * FROM invocations WHERE id = ?').get(id);
    if (!r) return null;
    return {
      id: r.id as string,
      conversationId: r.conversation_id as string,
      memberId: r.member_id as string,
      reason: r.reason as string,
      startedAt: Number(r.started_at),
      endedAt: r.ended_at == null ? null : Number(r.ended_at),
      outcome: (r.outcome as Outcome | null) ?? null,
    };
  }

  countInvocationsSince(conversationId: string, sinceMs: number): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM invocations WHERE conversation_id = ? AND started_at >= ?')
      .get(conversationId, sinceMs);
    return Number(r?.n ?? 0);
  }

  markUnfinishedInterrupted(): number {
    const info = this.db
      .prepare("UPDATE invocations SET ended_at = ?, outcome = 'interrupted' WHERE outcome IS NULL")
      .run(Date.now());
    return Number(info.changes);
  }
}
```

- [ ] **Step 5: 确认通过**

Run: `npx vitest run packages/hub && npm run typecheck`
Expected: 9 个测试 PASS。运行时会出现 `ExperimentalWarning: SQLite is an experimental feature`，属正常。

- [ ] **Step 6: Commit**

```bash
git add package-lock.json packages/hub
git commit -m "feat(hub): types, config store, SQLite store"
```

---

### Task 8: @ 解析与点名模型

**Files:**
- Create: `packages/hub/src/mentions.ts`, `packages/hub/src/triage.ts`
- Test: `packages/hub/test/triage.test.ts`

**Interfaces:**
- Consumes: `Member`（Task 7）、`TriageConfig`（Task 7）。
- Produces:
  - `parseMentions(body: string, members: Member[], senderId: string | null): string[]`
  - `interface TriageInput { transcript: { sender: string; body: string }[]; candidates: { id: string; name: string; bio: string }[] }`
  - `interface Triage { pick(input: TriageInput): Promise<string[]> }`（返回候选成员 id，按发言顺序）
  - `parseSpeakers(content: string, candidates: TriageInput['candidates']): string[]`
  - `class OpenAITriage implements Triage { constructor(cfg: TriageConfig, fetchImpl?: typeof fetch) }`

- [ ] **Step 1: 写失败的测试**

`packages/hub/test/triage.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseMentions } from '../src/mentions';
import { OpenAITriage, parseSpeakers } from '../src/triage';
import type { Member } from '../src/types';

const members: Member[] = [
  { id: 'h', kind: 'human', name: '我', bio: '', adapter: null },
  { id: 'a', kind: 'agent', name: 'Claude Code', bio: '', adapter: 'claude' },
  { id: 'b', kind: 'agent', name: 'Codex', bio: '', adapter: 'codex' },
];
const candidates = [
  { id: 'a', name: 'Claude Code', bio: 'x' },
  { id: 'b', name: 'Codex', bio: 'y' },
];

describe('parseMentions', () => {
  it('finds @Name for members, including names with spaces', () => {
    expect(parseMentions('@Claude Code 和 @Codex 看一下', members, 'h')).toEqual(['a', 'b']);
  });
  it('ignores self-mentions and unknown names', () => {
    expect(parseMentions('@Codex @Nobody', members, 'b')).toEqual([]);
  });
});

describe('parseSpeakers', () => {
  it('maps names to ids, keeps order, drops unknowns and duplicates', () => {
    expect(parseSpeakers('{"speakers":["Codex","Ghost","Claude Code","Codex"]}', candidates)).toEqual(['b', 'a']);
  });
  it('returns empty for a missing list', () => {
    expect(parseSpeakers('{}', candidates)).toEqual([]);
  });
  it('throws on invalid JSON', () => {
    expect(() => parseSpeakers('nope', candidates)).toThrow();
  });
});

describe('OpenAITriage', () => {
  const cfg = { baseUrl: 'http://llm.test/v1/', apiKey: 'secret', model: 'small' };
  const input = { transcript: [{ sender: '我', body: '谁懂 Rust？' }], candidates };

  it('posts a chat completion and returns the picked ids', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"speakers":["Codex"]}' } }] }));
    }) as unknown as typeof fetch;

    expect(await new OpenAITriage(cfg, fakeFetch).pick(input)).toEqual(['b']);
    expect(seen!.url).toBe('http://llm.test/v1/chat/completions');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer secret');
    const body = JSON.parse(seen!.init.body as string);
    expect(body.model).toBe('small');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[1].content).toContain('谁懂 Rust？');
    expect(body.messages[1].content).toContain('Claude Code: x');
  });

  it('throws on a non-2xx response', async () => {
    const fakeFetch = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    await expect(new OpenAITriage(cfg, fakeFetch).pick(input)).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run packages/hub/test/triage.test.ts`
Expected: FAIL，找不到 `../src/mentions`。

- [ ] **Step 3: 实现**

`packages/hub/src/mentions.ts`:
```ts
import type { Member } from './types';

export function parseMentions(body: string, members: Member[], senderId: string | null): string[] {
  return members.filter((m) => m.id !== senderId && body.includes(`@${m.name}`)).map((m) => m.id);
}
```

`packages/hub/src/triage.ts`:
```ts
import type { TriageConfig } from './config';

export interface TriageInput {
  transcript: { sender: string; body: string }[];
  candidates: { id: string; name: string; bio: string }[];
}

export interface Triage {
  /** Returns candidate ids in speaking order; may be empty. */
  pick(input: TriageInput): Promise<string[]>;
}

const SYSTEM = [
  'You moderate a group chat between a human and several AI agents.',
  'Given the recent messages and the agents who could speak, decide which agents should speak next and in what order.',
  'Pick an agent only if it can add something the conversation needs. Prefer few speakers.',
  'Return an empty list when nobody needs to respond, for example after a simple acknowledgement or when the topic has reached a natural end.',
  'Answer with JSON only: {"speakers": ["exact agent name", ...]}',
].join(' ');

export function parseSpeakers(content: string, candidates: TriageInput['candidates']): string[] {
  const obj = JSON.parse(content);
  const names: unknown[] = Array.isArray(obj?.speakers) ? obj.speakers : [];
  const ids: string[] = [];
  for (const name of names) {
    const c = candidates.find((x) => x.name === name);
    if (c && !ids.includes(c.id)) ids.push(c.id);
  }
  return ids;
}

export class OpenAITriage implements Triage {
  constructor(
    private readonly cfg: TriageConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async pick(input: TriageInput): Promise<string[]> {
    const user = [
      'Agents who could speak:',
      ...input.candidates.map((c) => `- ${c.name}: ${c.bio}`),
      '',
      'Recent messages:',
      ...input.transcript.map((m) => `${m.sender}: ${m.body}`),
    ].join('\n');
    const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`triage request failed with HTTP ${res.status}`);
    const data = (await res.json()) as any;
    return parseSpeakers(data?.choices?.[0]?.message?.content ?? '', input.candidates);
  }
}
```

- [ ] **Step 4: 确认通过**

Run: `npx vitest run packages/hub/test/triage.test.ts && npm run typecheck`
Expected: 7 个测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/hub
git commit -m "feat(hub): mention parsing and triage model client"
```

---

### Task 9: 调度器核心（私聊、合并等待、点名、依次发言、不开口）

**Files:**
- Create: `packages/hub/src/scheduler.ts`
- Test: `packages/hub/test/helpers.ts`, `packages/hub/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `Store`（Task 7）、`Triage`（Task 8）、`parseMentions`（Task 8）、`AgentAdapter` / `AdapterError` / `InvokeRequest` / `FakeAdapter`（Task 1）。
- Produces:
  ```ts
  interface SchedulerDeps {
    store: Store;
    adapters: Map<string, AgentAdapter>;      // key 为 adapter.name
    triage: () => Triage | null;
    emit: (e: HubEvent) => void;
    dataDir: string;
    isAvailable: (adapterName: string) => boolean;
  }
  class Scheduler {
    constructor(deps: SchedulerDeps)
    onMessage(msg: Message): void              // 人类消息入库后由服务层调用
    kick(conversationId: string): void         // 取消暂停后调用
    abortConversation(conversationId: string): void
    stopAll(): void
    resumeAll(): void
    isStopped(): boolean
    retryInvocation(invocationId: string): Promise<boolean>
  }
  ```
  本任务实现全部方法；Task 10 只补测试并修正测试暴露的问题。

- [ ] **Step 1: 写测试辅助**

`packages/hub/test/helpers.ts`:
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { FakeAdapter } from '@agent-chat/adapters';
import { Scheduler } from '../src/scheduler';
import { Store } from '../src/store';
import type { Triage, TriageInput } from '../src/triage';
import type { HubEvent, Settings } from '../src/types';

export class FakeTriage implements Triage {
  calls: TriageInput[] = [];
  /** Names to pick; 'ALL' picks every candidate in order. */
  pickNames: string[] | 'ALL' = [];
  fail = false;
  async pick(input: TriageInput): Promise<string[]> {
    this.calls.push(input);
    if (this.fail) throw new Error('triage down');
    if (this.pickNames === 'ALL') return input.candidates.map((c) => c.id);
    return this.pickNames
      .map((n) => input.candidates.find((c) => c.name === n)?.id)
      .filter((x): x is string => Boolean(x));
  }
}

export function setup(opts: { triage?: boolean; settings?: Partial<Settings> } = {}) {
  const store = new Store(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'agentchat-test-'));
  const fa = new FakeAdapter('fake-a', 'A');
  const fb = new FakeAdapter('fake-b', 'B');
  const human = store.createMember({ kind: 'human', name: '我' });
  const a = store.createMember({ kind: 'agent', name: 'A', bio: 'agent a', adapter: 'fake-a' });
  const b = store.createMember({ kind: 'agent', name: 'B', bio: 'agent b', adapter: 'fake-b' });
  const dm = store.createConversation({ kind: 'dm', title: 'A', memberIds: [human.id, a.id] });
  const group = store.createConversation({
    kind: 'group',
    title: 'G',
    memberIds: [human.id, a.id, b.id],
    settings: opts.settings,
  });
  const triage = new FakeTriage();
  const events: HubEvent[] = [];
  const unavailable = new Set<string>();
  const scheduler = new Scheduler({
    store,
    adapters: new Map([
      [fa.name, fa],
      [fb.name, fb],
    ]),
    triage: () => (opts.triage ? triage : null),
    emit: (e) => events.push(e),
    dataDir,
    isAvailable: (name) => !unavailable.has(name),
  });
  /** Stores a human message and notifies the scheduler, like the HTTP layer does. */
  const say = (conversationId: string, body: string, mentions: string[] = []) => {
    const m = store.addMessage({ conversationId, senderId: human.id, body, mentions });
    scheduler.onMessage(m);
    return m;
  };
  /** Runs timers until every chained round has finished. */
  const settle = async () => {
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(3000);
  };
  const bodies = (conversationId: string) => store.listMessages(conversationId, { limit: 500 }).map((m) => m.body);
  return { store, dataDir, fa, fb, human, a, b, dm, group, triage, events, unavailable, scheduler, say, settle, bodies };
}
```

- [ ] **Step 2: 写失败的测试**

`packages/hub/test/scheduler.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup } from './helpers';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('private chat', () => {
  it('always invokes the agent, stores its reply and does not loop on its own message', async () => {
    const t = setup();
    t.say(t.dm.id, '在吗');
    await t.settle();
    expect(t.fa.calls).toHaveLength(1);
    expect(t.fa.calls[0]).toMatchObject({ isGroup: false, agentName: 'A', harnessSessionId: null });
    expect(t.fa.calls[0].newMessages.map((m) => `${m.senderName}:${m.body}`)).toEqual(['我:在吗']);
    expect(t.bodies(t.dm.id)).toEqual(['在吗', 'reply from A']);
    expect(t.store.getAgentSession(t.dm.id, t.a.id)!.harnessSessionId).toBe('fake-a-session');
  });

  it('resumes the stored session and sends only unseen messages', async () => {
    const t = setup();
    t.say(t.dm.id, '第一句');
    await t.settle();
    t.say(t.dm.id, '第二句');
    await t.settle();
    expect(t.fa.calls[1].harnessSessionId).toBe('fake-a-session');
    expect(t.fa.calls[1].newMessages.map((m) => m.body)).toEqual(['第二句']);
  });

  it('emits typing and message events', async () => {
    const t = setup();
    t.say(t.dm.id, 'hi');
    await t.settle();
    const kinds = t.events.map((e) => (e.type === 'typing' ? `typing:${e.active}` : e.type));
    expect(kinds).toEqual(['typing:true', 'message', 'typing:false']);
  });
});

describe('group chat without a triage model', () => {
  it('invokes nobody when nobody is mentioned', async () => {
    const t = setup();
    t.say(t.group.id, '大家好');
    await t.settle();
    expect(t.fa.calls).toHaveLength(0);
    expect(t.fb.calls).toHaveLength(0);
  });

  it('invokes only the mentioned agent', async () => {
    const t = setup();
    t.say(t.group.id, '@B 你怎么看', [t.b.id]);
    await t.settle();
    expect(t.fa.calls).toHaveLength(0);
    expect(t.fb.calls).toHaveLength(1);
    expect(t.fb.calls[0]).toMatchObject({ isGroup: true, conversationTitle: 'G' });
  });
});

describe('group chat with a triage model', () => {
  it('waits for a quiet period and merges messages into one round', async () => {
    const t = setup({ triage: true });
    t.triage.pickNames = ['A'];
    t.say(t.group.id, '一');
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.fa.calls).toHaveLength(0);
    t.say(t.group.id, '二');
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.fa.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.fa.calls).toHaveLength(1);
    expect(t.fa.calls[0].newMessages.map((m) => m.body)).toEqual(['一', '二']);
  });

  it('gives the triage model the non-mentioned candidates and the transcript', async () => {
    const t = setup({ triage: true });
    t.say(t.group.id, '@A 谁懂 Rust', [t.a.id]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.triage.calls[0].candidates).toEqual([{ id: t.b.id, name: 'B', bio: 'agent b' }]);
    expect(t.triage.calls[0].transcript).toEqual([{ sender: '我', body: '@A 谁懂 Rust' }]);
  });

  it('runs speakers one after another: mentioned first, then picks, each seeing earlier replies', async () => {
    const t = setup({ triage: true, settings: { maxAgentRounds: 0 } });
    t.triage.pickNames = ['A'];
    t.say(t.group.id, '@B 先说', [t.b.id]);
    await t.settle();
    expect(t.bodies(t.group.id)).toEqual(['@B 先说', 'reply from B', 'reply from A']);
    expect(t.fa.calls[0].newMessages.map((m) => m.body)).toEqual(['@B 先说', 'reply from B']);
  });

  it('stores nothing when a picked agent stays silent', async () => {
    const t = setup({ triage: true, settings: { maxAgentRounds: 0 } });
    t.triage.pickNames = ['A'];
    t.fa.handler = async () => ({ kind: 'silent', harnessSessionId: 's' });
    t.say(t.group.id, '嗯');
    await t.settle();
    expect(t.bodies(t.group.id)).toEqual(['嗯']);
    const inv = t.store.countInvocationsSince(t.group.id, 0);
    expect(inv).toBe(1);
  });

  it('does not re-send messages an agent already saw while staying silent', async () => {
    const t = setup({ triage: true, settings: { maxAgentRounds: 0 } });
    t.triage.pickNames = ['A'];
    t.fa.handler = async () => ({ kind: 'silent', harnessSessionId: 's' });
    t.say(t.group.id, '一');
    await t.settle();
    t.say(t.group.id, '二');
    await t.settle();
    expect(t.fa.calls[1].newMessages.map((m) => m.body)).toEqual(['二']);
  });

  it('falls back to mentions only when the triage model fails', async () => {
    const t = setup({ triage: true });
    t.triage.fail = true;
    t.say(t.group.id, '@B 在吗', [t.b.id]);
    await t.settle();
    expect(t.fb.calls).toHaveLength(1);
    expect(t.fa.calls).toHaveLength(0);
  });

  it('skips unavailable agents', async () => {
    const t = setup({ triage: true, settings: { maxAgentRounds: 0 } });
    t.triage.pickNames = 'ALL';
    t.unavailable.add('fake-a');
    t.say(t.group.id, '@A 大家说说', [t.a.id]);
    await t.settle();
    expect(t.fa.calls).toHaveLength(0);
    expect(t.fb.calls).toHaveLength(1);
  });

  it('records mentions that an agent writes in its reply', async () => {
    const t = setup({ triage: true, settings: { maxAgentRounds: 0 } });
    t.triage.pickNames = ['A'];
    t.fa.handler = async () => ({ kind: 'reply', body: '@B 你来', harnessSessionId: 's' });
    t.say(t.group.id, '问题');
    await t.settle();
    const reply = t.store.listMessages(t.group.id).at(-1)!;
    expect(reply.mentions).toEqual([t.b.id]);
  });
});
```

- [ ] **Step 3: 确认失败**

Run: `npx vitest run packages/hub/test/scheduler.test.ts`
Expected: FAIL，找不到 `../src/scheduler`。

- [ ] **Step 4: 实现**

`packages/hub/src/scheduler.ts`:
```ts
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AdapterError } from '@agent-chat/adapters';
import type { AgentAdapter, InvokeRequest, InvokeResult } from '@agent-chat/adapters';
import { parseMentions } from './mentions';
import type { Store } from './store';
import type { Triage } from './triage';
import type { Conversation, HubEvent, Member, Message } from './types';

const HISTORY_REPLAY = 30;
const MAX_NEW_MESSAGES = 50;
const TRIAGE_TRANSCRIPT = 20;

export interface SchedulerDeps {
  store: Store;
  adapters: Map<string, AgentAdapter>;
  triage: () => Triage | null;
  emit: (e: HubEvent) => void;
  dataDir: string;
  isAvailable: (adapterName: string) => boolean;
}

interface ConvState {
  timer: NodeJS.Timeout | null;
  running: boolean;
  /** Consecutive rounds triggered without any human message. */
  agentRounds: number;
  lastProcessedSeq: number;
  abort: AbortController | null;
  capNoticeDay: string | null;
}

type Session = { harnessSessionId: string; lastSeenSeq: number };

export class Scheduler {
  private readonly states = new Map<string, ConvState>();
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  isStopped(): boolean {
    return this.stopped;
  }

  onMessage(msg: Message): void {
    if (msg.kind !== 'normal') return;
    const st = this.state(msg.conversationId, msg.seq - 1);
    const sender = msg.senderId ? this.deps.store.getMember(msg.senderId) : null;
    if (sender?.kind === 'human') st.agentRounds = 0;
    if (st.running) return;
    this.schedule(msg.conversationId);
  }

  kick(conversationId: string): void {
    const st = this.state(conversationId);
    if (!st.running) this.schedule(conversationId);
  }

  abortConversation(conversationId: string): void {
    const st = this.states.get(conversationId);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    st.abort?.abort();
  }

  stopAll(): void {
    this.stopped = true;
    for (const id of this.states.keys()) this.abortConversation(id);
    this.deps.emit({ type: 'stopped', stopped: true });
  }

  resumeAll(): void {
    this.stopped = false;
    this.deps.emit({ type: 'stopped', stopped: false });
    for (const c of this.deps.store.listConversations()) this.kick(c.id);
  }

  async retryInvocation(invocationId: string): Promise<boolean> {
    const inv = this.deps.store.getInvocation(invocationId);
    if (!inv || this.stopped) return false;
    const conv = this.deps.store.getConversation(inv.conversationId);
    const agent = this.deps.store.getMember(inv.memberId);
    if (!conv || !agent || conv.settings.paused) return false;
    const st = this.state(conv.id);
    if (st.running) return false;
    st.running = true;
    st.abort = new AbortController();
    try {
      await this.invokeAgent(conv, agent, 'retry', st.abort.signal);
    } finally {
      this.endRun(conv.id, st);
    }
    return true;
  }

  private state(conversationId: string, initialSeq?: number): ConvState {
    let st = this.states.get(conversationId);
    if (!st) {
      st = {
        timer: null,
        running: false,
        agentRounds: 0,
        lastProcessedSeq: initialSeq ?? this.deps.store.maxSeq(conversationId),
        abort: null,
        capNoticeDay: null,
      };
      this.states.set(conversationId, st);
    }
    return st;
  }

  private schedule(conversationId: string): void {
    const conv = this.deps.store.getConversation(conversationId);
    if (!conv) return;
    const st = this.state(conversationId);
    if (st.timer) clearTimeout(st.timer);
    const delay = conv.kind === 'dm' ? 0 : conv.settings.debounceMs;
    st.timer = setTimeout(() => {
      st.timer = null;
      void this.runRound(conversationId);
    }, delay);
  }

  private endRun(conversationId: string, st: ConvState): void {
    st.running = false;
    st.abort = null;
    if (!this.stopped && this.deps.store.maxSeq(conversationId) > st.lastProcessedSeq) this.schedule(conversationId);
  }

  private async runRound(conversationId: string): Promise<void> {
    const { store } = this.deps;
    const st = this.state(conversationId);
    if (st.running || this.stopped) return;
    const conv = store.getConversation(conversationId);
    if (!conv || conv.settings.paused) return;
    const pending = store.listMessagesAfter(conversationId, st.lastProcessedSeq);
    const triggers = pending.filter((m) => m.kind === 'normal');
    if (pending.length > 0) st.lastProcessedSeq = pending[pending.length - 1].seq;
    if (triggers.length === 0) return;

    st.running = true;
    st.abort = new AbortController();
    const signal = st.abort.signal;
    try {
      const members = store.listConversationMembers(conversationId);
      const humanIds = new Set(members.filter((m) => m.kind === 'human').map((m) => m.id));
      const hasHuman = triggers.some((m) => m.senderId !== null && humanIds.has(m.senderId));
      if (!hasHuman) {
        if (st.agentRounds >= conv.settings.maxAgentRounds) return;
        st.agentRounds++;
      }
      const speakers = await this.pickSpeakers(conv, members, triggers);
      for (const agent of speakers) {
        if (signal.aborted || this.stopped) break;
        const current = store.getConversation(conversationId);
        if (!current || current.settings.paused) break;
        if (!this.underDailyCap(current, st)) break;
        const completed = await this.invokeAgent(current, agent, 'round', signal);
        if (!completed) break;
      }
    } finally {
      this.endRun(conversationId, st);
    }
  }

  private async pickSpeakers(conv: Conversation, members: Member[], triggers: Message[]): Promise<Member[]> {
    const agents = members.filter((m) => m.kind === 'agent' && m.adapter !== null && this.deps.isAvailable(m.adapter));
    // An agent never answers a round made up only of its own messages.
    const eligible = agents.filter((a) => !triggers.every((t) => t.senderId === a.id));
    if (conv.kind === 'dm') return eligible;

    const mentioned: Member[] = [];
    for (const t of triggers) {
      for (const id of t.mentions) {
        const a = eligible.find((x) => x.id === id);
        if (a && a.id !== t.senderId && !mentioned.includes(a)) mentioned.push(a);
      }
    }
    const rest = eligible.filter((a) => !mentioned.includes(a));
    const triage = this.deps.triage();
    if (!triage || rest.length === 0) return mentioned;

    const nameOf = (id: string | null) => members.find((m) => m.id === id)?.name ?? '系统';
    const transcript = this.deps.store
      .listMessages(conv.id, { limit: TRIAGE_TRANSCRIPT })
      .filter((m) => m.kind === 'normal')
      .map((m) => ({ sender: nameOf(m.senderId), body: m.body }));
    let picked: Member[] = [];
    try {
      const ids = await triage.pick({
        transcript,
        candidates: rest.map((a) => ({ id: a.id, name: a.name, bio: a.bio })),
      });
      for (const id of ids) {
        const a = rest.find((x) => x.id === id);
        if (a && !picked.includes(a)) picked.push(a);
      }
    } catch {
      picked = [];
    }
    return [...mentioned, ...picked];
  }

  private underDailyCap(conv: Conversation, st: ConvState): boolean {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const used = this.deps.store.countInvocationsSince(conv.id, dayStart.getTime());
    if (used < conv.settings.dailyInvocationCap) return true;
    const day = dayStart.toDateString();
    if (st.capNoticeDay !== day) {
      st.capNoticeDay = day;
      this.system(conv.id, `今日唤起次数已达上限（${conv.settings.dailyInvocationCap}），agent 暂停发言。`);
    }
    return false;
  }

  /** Returns false when the invocation was aborted and the round should stop. */
  private async invokeAgent(conv: Conversation, agent: Member, reason: string, signal: AbortSignal): Promise<boolean> {
    const { store, emit } = this.deps;
    const adapter = agent.adapter ? this.deps.adapters.get(agent.adapter) : undefined;
    if (!adapter) return true;
    const invocationId = store.startInvocation(conv.id, agent.id, reason);
    emit({ type: 'typing', conversationId: conv.id, memberId: agent.id, active: true });
    try {
      const { result, seenSeq } = await this.callAdapter(adapter, conv, agent, signal);
      store.setAgentSession(conv.id, agent.id, result.harnessSessionId, seenSeq);
      if (result.kind === 'reply') {
        const members = store.listConversationMembers(conv.id);
        const message = store.addMessage({
          conversationId: conv.id,
          senderId: agent.id,
          body: result.body,
          mentions: parseMentions(result.body, members, agent.id),
        });
        emit({ type: 'message', message });
        store.finishInvocation(invocationId, 'replied');
      } else {
        store.finishInvocation(invocationId, 'silent');
      }
      return true;
    } catch (e) {
      const code = e instanceof AdapterError ? e.code : 'crashed';
      if (code === 'aborted') {
        store.finishInvocation(invocationId, 'interrupted');
        return false;
      }
      if (code === 'timeout') {
        store.finishInvocation(invocationId, 'timeout');
        this.system(conv.id, `${agent.name} 没有回应（超时）。`, { invocationId, retryable: true });
        return true;
      }
      store.finishInvocation(invocationId, 'error');
      this.system(conv.id, `${agent.name} 出错：${(e as Error).message}`, { invocationId, retryable: true });
      return true;
    } finally {
      emit({ type: 'typing', conversationId: conv.id, memberId: agent.id, active: false });
    }
  }

  private async callAdapter(
    adapter: AgentAdapter,
    conv: Conversation,
    agent: Member,
    signal: AbortSignal,
  ): Promise<{ result: InvokeResult; seenSeq: number }> {
    const session = this.deps.store.getAgentSession(conv.id, agent.id);
    const first = this.buildRequest(conv, agent, session, signal);
    try {
      return { result: await adapter.invoke(first.req), seenSeq: first.seenSeq };
    } catch (e) {
      // A stored harness session may be gone; start over once with recent history.
      if (session && e instanceof AdapterError && e.code === 'crashed') {
        this.deps.store.clearAgentSession(conv.id, agent.id);
        const fresh = this.buildRequest(conv, agent, null, signal);
        return { result: await adapter.invoke(fresh.req), seenSeq: fresh.seenSeq };
      }
      throw e;
    }
  }

  private buildRequest(
    conv: Conversation,
    agent: Member,
    session: Session | null,
    signal: AbortSignal,
  ): { req: InvokeRequest; seenSeq: number } {
    const { store, dataDir } = this.deps;
    const members = store.listConversationMembers(conv.id);
    const nameOf = (id: string | null) => members.find((m) => m.id === id)?.name ?? '系统';
    const source = session
      ? store.listMessagesAfter(conv.id, session.lastSeenSeq).filter((m) => m.senderId !== agent.id)
      : store.listMessages(conv.id, { limit: HISTORY_REPLAY });
    const messages = source.filter((m) => m.kind === 'normal').slice(-MAX_NEW_MESSAGES);
    const workdir = join(dataDir, 'workspaces', agent.adapter!);
    mkdirSync(workdir, { recursive: true });
    const req: InvokeRequest = {
      conversationId: conv.id,
      agentName: agent.name,
      conversationTitle: conv.title,
      isGroup: conv.kind === 'group',
      harnessSessionId: session?.harnessSessionId ?? null,
      newMessages: messages.map((m) => ({
        id: m.id,
        senderName: nameOf(m.senderId),
        body: m.body,
        createdAt: m.createdAt,
        attachments: m.attachments.map((a) => this.materialize(a.file, workdir)).filter((p): p is string => p !== null),
      })),
      workdir,
      signal,
      timeoutMs: conv.settings.timeoutMs,
    };
    return { req, seenSeq: store.maxSeq(conv.id) };
  }

  /** Copies an attachment into the agent's workdir so every harness can read it. */
  private materialize(file: string, workdir: string): string | null {
    const src = join(this.deps.dataDir, 'attachments', file);
    if (!existsSync(src)) return null;
    const dest = join(workdir, 'attachments', file);
    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
    return dest;
  }

  private system(conversationId: string, body: string, meta: Record<string, unknown> | null = null): void {
    const message = this.deps.store.addMessage({ conversationId, senderId: null, kind: 'system', body, meta });
    this.deps.emit({ type: 'message', message });
  }
}
```

- [ ] **Step 5: 确认通过**

Run: `npx vitest run packages/hub/test/scheduler.test.ts && npm run typecheck`
Expected: 13 个测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/hub
git commit -m "feat(hub): scheduler with debounce, triage and sequential speakers"
```

---

### Task 10: 调度器的限制与出错路径

**Files:**
- Test: `packages/hub/test/scheduler-limits.test.ts`
- Modify: `packages/hub/src/scheduler.ts`（仅当下列测试暴露问题时）

**Interfaces:**
- Consumes: Task 9 的 `Scheduler` 全部方法、`helpers.ts` 的 `setup`。
- Produces: 无新接口；本任务用测试锁定规格第 5.3 节和第 8 节的行为。

- [ ] **Step 1: 写测试**

`packages/hub/test/scheduler-limits.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterError } from '@agent-chat/adapters';
import type { InvokeRequest, InvokeResult } from '@agent-chat/adapters';
import { setup } from './helpers';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const hang = (req: InvokeRequest) =>
  new Promise<InvokeResult>((_, reject) => {
    req.signal.addEventListener('abort', () => reject(new AdapterError('aborted', 'aborted')));
  });

describe('consecutive agent rounds', () => {
  it('stops after maxAgentRounds agent-only rounds and resumes when the human speaks', async () => {
    const t = setup({ triage: true, settings: { maxAgentRounds: 2 } });
    t.triage.pickNames = 'ALL';
    t.say(t.group.id, '开始讨论');
    await t.settle();
    // 1 human-triggered round + 2 agent-only rounds, 2 agents each.
    expect(t.fa.calls.length + t.fb.calls.length).toBe(6);

    t.say(t.group.id, '继续');
    await t.settle();
    expect(t.fa.calls.length + t.fb.calls.length).toBe(12);
  });
});

describe('daily cap', () => {
  it('stops invoking and posts one system notice', async () => {
    const t = setup({ triage: true, settings: { dailyInvocationCap: 1, maxAgentRounds: 0 } });
    t.triage.pickNames = 'ALL';
    t.say(t.group.id, '一');
    await t.settle();
    t.say(t.group.id, '二');
    await t.settle();
    expect(t.fa.calls.length + t.fb.calls.length).toBe(1);
    const notices = t.store.listMessages(t.group.id).filter((m) => m.kind === 'system');
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain('上限');
  });
});

describe('pause', () => {
  it('invokes nobody while paused and catches up after kick', async () => {
    const t = setup();
    t.store.updateSettings(t.group.id, { paused: true });
    t.say(t.group.id, '@A 在吗', [t.a.id]);
    await t.settle();
    expect(t.fa.calls).toHaveLength(0);

    t.store.updateSettings(t.group.id, { paused: false });
    t.scheduler.kick(t.group.id);
    await t.settle();
    expect(t.fa.calls).toHaveLength(1);
  });

  it('abortConversation interrupts a running invocation', async () => {
    const t = setup();
    t.fa.handler = hang;
    const m = t.say(t.dm.id, 'hi');
    await vi.advanceTimersByTimeAsync(10);
    expect(t.fa.calls).toHaveLength(1);
    t.scheduler.abortConversation(t.dm.id);
    await t.settle();
    expect(t.bodies(t.dm.id)).toEqual(['hi']);
    expect(m.seq).toBeGreaterThan(0);
  });
});

describe('global stop', () => {
  it('aborts running work, blocks new work, and resumes on request', async () => {
    const t = setup();
    t.fa.handler = hang;
    t.say(t.dm.id, '一');
    await vi.advanceTimersByTimeAsync(10);
    t.scheduler.stopAll();
    await t.settle();
    expect(t.scheduler.isStopped()).toBe(true);
    expect(t.events.some((e) => e.type === 'stopped' && e.stopped)).toBe(true);
    expect(t.bodies(t.dm.id)).toEqual(['一']);

    t.fa.handler = async () => ({ kind: 'reply', body: 'back', harnessSessionId: 's' });
    t.say(t.dm.id, '二');
    await t.settle();
    expect(t.fa.calls).toHaveLength(1);

    t.scheduler.resumeAll();
    await t.settle();
    expect(t.fa.calls).toHaveLength(2);
    expect(t.bodies(t.dm.id)).toEqual(['一', '二', 'back']);
  });
});

describe('errors', () => {
  it('posts a retryable system message on timeout and retries on request', async () => {
    const t = setup();
    t.fa.handler = async () => {
      throw new AdapterError('timeout', 'no result');
    };
    t.say(t.dm.id, 'hi');
    await t.settle();
    const notice = t.store.listMessages(t.dm.id).at(-1)!;
    expect(notice.kind).toBe('system');
    expect(notice.body).toContain('超时');
    expect(notice.meta).toMatchObject({ retryable: true });
    const invocationId = notice.meta!.invocationId as string;
    expect(t.store.getInvocation(invocationId)!.outcome).toBe('timeout');

    t.fa.handler = async () => ({ kind: 'reply', body: 'now ok', harnessSessionId: 's' });
    expect(await t.scheduler.retryInvocation(invocationId)).toBe(true);
    await t.settle();
    expect(t.bodies(t.dm.id).at(-1)).toBe('now ok');
    expect(t.fa.calls[1].newMessages.map((m) => m.body)).toEqual(['hi']);
  });

  it('posts the error text when the agent crashes without a stored session', async () => {
    const t = setup();
    t.fa.handler = async () => {
      throw new AdapterError('crashed', 'boom');
    };
    t.say(t.dm.id, 'hi');
    await t.settle();
    const notice = t.store.listMessages(t.dm.id).at(-1)!;
    expect(notice.body).toContain('boom');
    expect(t.fa.calls).toHaveLength(1);
  });

  it('starts a fresh session with recent history when the stored session is lost', async () => {
    const t = setup();
    t.say(t.dm.id, '第一句');
    await t.settle();
    t.fa.handler = async (req) => {
      if (req.harnessSessionId) throw new AdapterError('crashed', 'unknown session');
      return { kind: 'reply', body: 'recovered', harnessSessionId: 'new-session' };
    };
    t.say(t.dm.id, '第二句');
    await t.settle();
    const last = t.fa.calls.at(-1)!;
    expect(last.harnessSessionId).toBeNull();
    expect(last.newMessages.map((m) => m.body)).toEqual(['第一句', 'reply from A', '第二句']);
    expect(t.store.getAgentSession(t.dm.id, t.a.id)!.harnessSessionId).toBe('new-session');
    expect(t.bodies(t.dm.id).at(-1)).toBe('recovered');
  });

  it('retryInvocation refuses unknown ids', async () => {
    const t = setup();
    expect(await t.scheduler.retryInvocation('nope')).toBe(false);
  });
});

describe('attachments', () => {
  it('copies attachments into the agent workdir and passes those paths', async () => {
    const t = setup();
    mkdirSync(join(t.dataDir, 'attachments', t.dm.id), { recursive: true });
    writeFileSync(join(t.dataDir, 'attachments', t.dm.id, 'note.txt'), 'hello');
    const m = t.store.addMessage({
      conversationId: t.dm.id,
      senderId: t.human.id,
      body: '看附件',
      attachments: [{ name: 'note.txt', file: `${t.dm.id}/note.txt` }],
    });
    t.scheduler.onMessage(m);
    await t.settle();
    const path = t.fa.calls[0].newMessages[0].attachments[0];
    expect(path).toBe(join(t.dataDir, 'workspaces', 'fake-a', 'attachments', t.dm.id, 'note.txt'));
    expect(existsSync(path)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行**

Run: `npx vitest run packages/hub/test/scheduler-limits.test.ts`
Expected: 10 个测试 PASS。Task 9 的实现已覆盖这些行为；如有失败，按失败信息修正 `packages/hub/src/scheduler.ts`，不得修改测试的断言来迁就实现。

- [ ] **Step 3: 全量确认**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add packages/hub
git commit -m "test(hub): lock scheduler limits, stop, retry and recovery behaviour"
```

---

### Task 11: HTTP/WebSocket 接口、种子数据、进程入口

**Files:**
- Create: `packages/hub/src/bootstrap.ts`, `packages/hub/src/server.ts`, `packages/hub/src/main.ts`
- Test: `packages/hub/test/server.test.ts`

**Interfaces:**
- Consumes: `Store`, `ConfigStore`, `Scheduler`, `parseMentions`, `OpenAITriage`, 四个真实适配器, `dshModelPatch`, `FakeAdapter`。
- Produces:
  - `seed(store: Store, adapters: AgentAdapter[]): void`：数据库没有成员时创建人类成员"我"、每个适配器一个 agent 成员、以及"我"与每个 agent 的私聊。
  - `class Bus { emit(e: HubEvent): void; on(fn: (e: HubEvent) => void): () => void }`
  - `buildServer(deps: ServerDeps): FastifyInstance`，`ServerDeps = { store, scheduler, config: ConfigStore, bus: Bus, availability: Map<string, Availability> }`
  - HTTP 接口（全部要求 `Authorization: Bearer <token>`）：

    | 方法与路径 | 请求体 | 返回 |
    |---|---|---|
    | `GET /api/state` | | `{ me: Member, members: (Member & { availability: Availability \| null })[], conversations: Conversation[], stopped: boolean }` |
    | `GET /api/conversations/:id/messages?beforeSeq=&limit=` | | `Message[]` |
    | `POST /api/conversations` | `{ title: string, memberIds: string[] }` | `Conversation`（群；自动加入"我"） |
    | `PATCH /api/conversations/:id/settings` | `Partial<Settings>` | `Conversation` |
    | `POST /api/conversations/:id/messages` | `{ body: string, replyTo?: string, attachments?: Attachment[] }` | `Message` |
    | `POST /api/conversations/:id/attachments?name=` | 原始字节，`content-type: application/octet-stream` | `Attachment` |
    | `GET /api/attachments/*` | | 文件内容 |
    | `PATCH /api/members/:id` | `{ bio: string }` | `Member` |
    | `POST /api/stop`、`POST /api/resume` | | `{ stopped: boolean }` |
    | `POST /api/invocations/:id/retry` | | `{ started: boolean }` |
    | `GET /api/config` | | `{ triage: { baseUrl, model, hasKey: boolean } \| null, dsh: { provider, model } \| null }` |
    | `PUT /api/config` | `{ triage?: TriageConfig \| null, dsh?: { provider, model } \| null }` | 同 `GET /api/config` |

  - WebSocket `/ws`：客户端首条消息须为 `{"type":"auth","token":"..."}`，通过后服务端回 `{"type":"ready"}`，之后推送 `HubEvent`；令牌错误则关闭连接。

- [ ] **Step 1: 写失败的测试**

`packages/hub/test/server.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { FakeAdapter } from '@agent-chat/adapters';
import { seed } from '../src/bootstrap';
import { ConfigStore } from '../src/config';
import { Scheduler } from '../src/scheduler';
import { Bus, buildServer } from '../src/server';
import { Store } from '../src/store';

let app: FastifyInstance;
let store: Store;
let config: ConfigStore;
let fa: FakeAdapter;
let fb: FakeAdapter;
let dataDir: string;
let auth: { authorization: string };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await wait(10);
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agentchat-srv-'));
  store = new Store(':memory:');
  config = new ConfigStore(dataDir);
  fa = new FakeAdapter('fake-a', 'A');
  fb = new FakeAdapter('fake-b', 'B');
  seed(store, [fa, fb]);
  const bus = new Bus();
  const availability = new Map([
    ['fake-a', { ok: true }],
    ['fake-b', { ok: false, reason: '未登录' }],
  ]);
  const scheduler = new Scheduler({
    store,
    adapters: new Map([
      [fa.name, fa],
      [fb.name, fb],
    ]),
    triage: () => null,
    emit: (e) => bus.emit(e),
    dataDir,
    isAvailable: (n) => availability.get(n)?.ok ?? false,
  });
  app = buildServer({ store, scheduler, config, bus, availability });
  auth = { authorization: `Bearer ${config.get().token}` };
});

afterEach(async () => {
  await app.close();
});

const state = async () => (await app.inject({ method: 'GET', url: '/api/state', headers: auth })).json();

describe('seed', () => {
  it('creates the human, one agent per adapter and their private chats, once', () => {
    seed(store, [fa, fb]);
    expect(store.listMembers().map((m) => m.name)).toEqual(['我', 'A', 'B']);
    expect(store.listMembers()[1]).toMatchObject({ kind: 'agent', adapter: 'fake-a', bio: fa.defaultBio });
    expect(store.listConversations().map((c) => `${c.kind}:${c.title}`)).toEqual(['dm:A', 'dm:B']);
  });
});

describe('auth', () => {
  it('rejects requests without the token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer wrong' } })).statusCode,
    ).toBe(401);
  });
});

describe('state', () => {
  it('returns me, members with availability, conversations and the stop flag', async () => {
    const s = await state();
    expect(s.me.name).toBe('我');
    expect(s.members.find((m: any) => m.name === 'B').availability).toEqual({ ok: false, reason: '未登录' });
    expect(s.members.find((m: any) => m.name === '我').availability).toBeNull();
    expect(s.conversations).toHaveLength(2);
    expect(s.stopped).toBe(false);
  });
});

describe('messages', () => {
  it('stores a message, lets the agent reply, and lists history', async () => {
    const s = await state();
    const dm = s.conversations.find((c: any) => c.title === 'A');
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${dm.id}/messages`,
      headers: auth,
      payload: { body: '在吗' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ body: '在吗', senderId: s.me.id, kind: 'normal' });
    await until(() => store.listMessages(dm.id).length === 2);
    const list = await app.inject({ method: 'GET', url: `/api/conversations/${dm.id}/messages?limit=1`, headers: auth });
    expect(list.json().map((m: any) => m.body)).toEqual(['reply from A']);
  });

  it('parses mentions from the body', async () => {
    const s = await state();
    const a = s.members.find((m: any) => m.name === 'A');
    const group = (
      await app.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: auth,
        payload: { title: '群', memberIds: [a.id] },
      })
    ).json();
    expect(group.kind).toBe('group');
    expect(group.memberIds).toContain(s.me.id);
    await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${group.id}/settings`,
      headers: auth,
      payload: { debounceMs: 10 },
    });
    const msg = (
      await app.inject({
        method: 'POST',
        url: `/api/conversations/${group.id}/messages`,
        headers: auth,
        payload: { body: '@A 你好' },
      })
    ).json();
    expect(msg.mentions).toEqual([a.id]);
    await until(() => fa.calls.length === 1);
  });

  it('rejects empty messages and unknown conversations', async () => {
    const s = await state();
    const id = s.conversations[0].id;
    const empty = await app.inject({ method: 'POST', url: `/api/conversations/${id}/messages`, headers: auth, payload: { body: '  ' } });
    expect(empty.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/conversations/nope/messages', headers: auth, payload: { body: 'x' } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('settings, stop and config', () => {
  it('pauses a conversation and reports it', async () => {
    const s = await state();
    const id = s.conversations[0].id;
    const res = await app.inject({ method: 'PATCH', url: `/api/conversations/${id}/settings`, headers: auth, payload: { paused: true } });
    expect(res.json().settings.paused).toBe(true);
    await app.inject({ method: 'POST', url: `/api/conversations/${id}/messages`, headers: auth, payload: { body: 'hi' } });
    await wait(50);
    expect(fa.calls).toHaveLength(0);
    await app.inject({ method: 'PATCH', url: `/api/conversations/${id}/settings`, headers: auth, payload: { paused: false } });
    await until(() => fa.calls.length === 1);
  });

  it('ignores unknown settings keys', async () => {
    const s = await state();
    const id = s.conversations[0].id;
    const res = await app.inject({ method: 'PATCH', url: `/api/conversations/${id}/settings`, headers: auth, payload: { bogus: 1, maxAgentRounds: 3 } });
    expect(res.json().settings.maxAgentRounds).toBe(3);
    expect(res.json().settings.bogus).toBeUndefined();
  });

  it('stops and resumes globally', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/stop', headers: auth })).json()).toEqual({ stopped: true });
    expect((await state()).stopped).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/resume', headers: auth })).json()).toEqual({ stopped: false });
  });

  it('stores the triage key but never returns it', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: auth,
      payload: { triage: { baseUrl: 'http://x/v1', apiKey: 'secret', model: 'm' }, dsh: { provider: 'my-provider', model: 'd' } },
    });
    expect(put.json()).toEqual({ triage: { baseUrl: 'http://x/v1', model: 'm', hasKey: true }, dsh: { provider: 'my-provider', model: 'd' } });
    expect(JSON.stringify((await app.inject({ method: 'GET', url: '/api/config', headers: auth })).json())).not.toContain('secret');
    expect(config.get().triage!.apiKey).toBe('secret');
  });

  it('updates a member bio', async () => {
    const s = await state();
    const a = s.members.find((m: any) => m.name === 'A');
    const res = await app.inject({ method: 'PATCH', url: `/api/members/${a.id}`, headers: auth, payload: { bio: '新介绍' } });
    expect(res.json().bio).toBe('新介绍');
  });
});

describe('attachments', () => {
  it('uploads, serves, and blocks path traversal', async () => {
    const s = await state();
    const id = s.conversations[0].id;
    const up = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/attachments?name=${encodeURIComponent('笔记 1.txt')}`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('hello'),
    });
    expect(up.statusCode).toBe(200);
    const att = up.json();
    expect(att.name).toBe('笔记 1.txt');
    expect(att.file.startsWith(`${id}/`)).toBe(true);
    expect(readFileSync(join(dataDir, 'attachments', att.file), 'utf8')).toBe('hello');
    const get = await app.inject({ method: 'GET', url: `/api/attachments/${att.file}`, headers: auth });
    expect(get.body).toBe('hello');
    const bad = await app.inject({ method: 'GET', url: '/api/attachments/..%2Fconfig.json', headers: auth });
    expect(bad.statusCode).toBe(404);
  });
});

describe('websocket', () => {
  it('requires auth, then pushes message events', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const received: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'auth', token: config.get().token }));
    await until(() => received.some((e) => e.type === 'ready'));

    const s = await state();
    const dm = s.conversations.find((c: any) => c.title === 'A');
    await app.inject({ method: 'POST', url: `/api/conversations/${dm.id}/messages`, headers: auth, payload: { body: 'hi' } });
    await until(() => received.filter((e) => e.type === 'message').length === 2);
    expect(received.filter((e) => e.type === 'message').map((e) => e.message.body)).toEqual(['hi', 'reply from A']);
    ws.close();

    const bad = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => bad.on('open', r));
    bad.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    await new Promise((r) => bad.on('close', r));
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run packages/hub/test/server.test.ts`
Expected: FAIL，找不到 `../src/bootstrap`。

- [ ] **Step 3: 实现种子数据和服务**

`packages/hub/src/bootstrap.ts`:
```ts
import type { AgentAdapter } from '@agent-chat/adapters';
import type { Store } from './store';

/** Creates the human, one agent member per adapter, and their private chats on first run. */
export function seed(store: Store, adapters: AgentAdapter[]): void {
  if (store.listMembers().length > 0) return;
  const me = store.createMember({ kind: 'human', name: '我' });
  for (const adapter of adapters) {
    const agent = store.createMember({
      kind: 'agent',
      name: adapter.displayName,
      bio: adapter.defaultBio,
      adapter: adapter.name,
    });
    store.createConversation({ kind: 'dm', title: adapter.displayName, memberIds: [me.id, agent.id] });
  }
}
```

`packages/hub/src/server.ts`:
```ts
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { Availability } from '@agent-chat/adapters';
import type { ConfigStore, TriageConfig } from './config';
import { parseMentions } from './mentions';
import type { Scheduler } from './scheduler';
import type { Store } from './store';
import type { Attachment, HubEvent, Settings } from './types';

export class Bus {
  private readonly listeners = new Set<(e: HubEvent) => void>();
  emit(e: HubEvent): void {
    for (const fn of this.listeners) fn(e);
  }
  on(fn: (e: HubEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export interface ServerDeps {
  store: Store;
  scheduler: Scheduler;
  config: ConfigStore;
  bus: Bus;
  availability: Map<string, Availability>;
}

const NUMERIC_SETTINGS = ['debounceMs', 'maxAgentRounds', 'dailyInvocationCap', 'timeoutMs'] as const;

function cleanSettings(input: Record<string, unknown>): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const key of NUMERIC_SETTINGS) {
    const v = input[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) patch[key] = Math.floor(v);
  }
  if (typeof input.paused === 'boolean') patch.paused = input.paused;
  return patch;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { store, scheduler, config, bus, availability } = deps;
  const app = Fastify({ bodyLimit: 50 * 1024 * 1024 });
  const attachmentsRoot = join(config.dataDir, 'attachments');
  const me = () => store.listMembers().find((m) => m.kind === 'human')!;

  const publicConfig = () => {
    const c = config.get();
    return {
      triage: c.triage ? { baseUrl: c.triage.baseUrl, model: c.triage.model, hasKey: Boolean(c.triage.apiKey) } : null,
      dsh: c.dsh,
    };
  };

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.register(websocket);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.headers.authorization !== `Bearer ${config.get().token}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.register(async (ws) => {
    ws.get('/ws', { websocket: true }, (socket) => {
      let off: (() => void) | null = null;
      socket.on('message', (raw: Buffer) => {
        if (off) return;
        let msg: any = null;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          // handled below
        }
        if (msg?.type !== 'auth' || msg.token !== config.get().token) {
          socket.close(4001, 'unauthorized');
          return;
        }
        off = bus.on((e) => socket.send(JSON.stringify(e)));
        socket.send(JSON.stringify({ type: 'ready' }));
      });
      socket.on('close', () => off?.());
    });
  });

  app.get('/api/state', async () => ({
    me: me(),
    members: store.listMembers().map((m) => ({
      ...m,
      availability: m.adapter ? (availability.get(m.adapter) ?? { ok: false, reason: '尚未检查' }) : null,
    })),
    conversations: store.listConversations(),
    stopped: scheduler.isStopped(),
  }));

  app.get<{ Params: { id: string }; Querystring: { beforeSeq?: string; limit?: string } }>(
    '/api/conversations/:id/messages',
    async (req, reply) => {
      if (!store.getConversation(req.params.id)) return reply.code(404).send({ error: 'unknown conversation' });
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const beforeSeq = req.query.beforeSeq ? Number(req.query.beforeSeq) : undefined;
      return store.listMessages(req.params.id, { beforeSeq, limit });
    },
  );

  app.post<{ Body: { title?: string; memberIds?: string[] } }>('/api/conversations', async (req, reply) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const ids = Array.isArray(req.body?.memberIds) ? req.body.memberIds.filter((id) => store.getMember(id)) : [];
    if (!title || ids.length === 0) return reply.code(400).send({ error: 'title and memberIds are required' });
    const conversation = store.createConversation({ kind: 'group', title, memberIds: [me().id, ...ids] });
    bus.emit({ type: 'conversation', conversation });
    return conversation;
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/conversations/:id/settings',
    async (req, reply) => {
      const before = store.getConversation(req.params.id);
      if (!before) return reply.code(404).send({ error: 'unknown conversation' });
      const conversation = store.updateSettings(req.params.id, cleanSettings(req.body ?? {}));
      if (conversation.settings.paused && !before.settings.paused) scheduler.abortConversation(conversation.id);
      if (!conversation.settings.paused && before.settings.paused) scheduler.kick(conversation.id);
      bus.emit({ type: 'conversation', conversation });
      return conversation;
    },
  );

  app.post<{ Params: { id: string }; Body: { body?: string; replyTo?: string; attachments?: Attachment[] } }>(
    '/api/conversations/:id/messages',
    async (req, reply) => {
      const conv = store.getConversation(req.params.id);
      if (!conv) return reply.code(404).send({ error: 'unknown conversation' });
      const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
      const attachments = (Array.isArray(req.body?.attachments) ? req.body.attachments : []).filter(
        (a) => typeof a?.name === 'string' && typeof a?.file === 'string' && a.file.startsWith(`${conv.id}/`),
      );
      if (!body && attachments.length === 0) return reply.code(400).send({ error: 'empty message' });
      const sender = me();
      const message = store.addMessage({
        conversationId: conv.id,
        senderId: sender.id,
        body,
        mentions: parseMentions(body, store.listConversationMembers(conv.id), sender.id),
        replyTo: typeof req.body?.replyTo === 'string' ? req.body.replyTo : null,
        attachments,
      });
      bus.emit({ type: 'message', message });
      scheduler.onMessage(message);
      return message;
    },
  );

  app.post<{ Params: { id: string }; Querystring: { name?: string }; Body: Buffer }>(
    '/api/conversations/:id/attachments',
    async (req, reply) => {
      if (!store.getConversation(req.params.id)) return reply.code(404).send({ error: 'unknown conversation' });
      if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'send raw bytes as application/octet-stream' });
      const name = basename(req.query.name || 'file');
      const safe = name.replace(/[^\p{L}\p{N}._-]+/gu, '_');
      const file = `${req.params.id}/${randomUUID()}-${safe}`;
      mkdirSync(join(attachmentsRoot, req.params.id), { recursive: true });
      writeFileSync(join(attachmentsRoot, file), req.body);
      const attachment: Attachment = { name, file };
      return attachment;
    },
  );

  app.get<{ Params: { '*': string } }>('/api/attachments/*', async (req, reply) => {
    const full = resolve(attachmentsRoot, req.params['*']);
    if (!full.startsWith(resolve(attachmentsRoot) + sep) || !existsSync(full)) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.type('application/octet-stream').send(readFileSync(full));
  });

  app.patch<{ Params: { id: string }; Body: { bio?: string } }>('/api/members/:id', async (req, reply) => {
    if (!store.getMember(req.params.id)) return reply.code(404).send({ error: 'unknown member' });
    if (typeof req.body?.bio !== 'string') return reply.code(400).send({ error: 'bio is required' });
    store.updateMemberBio(req.params.id, req.body.bio);
    return store.getMember(req.params.id);
  });

  app.post('/api/stop', async () => {
    scheduler.stopAll();
    return { stopped: true };
  });

  app.post('/api/resume', async () => {
    scheduler.resumeAll();
    return { stopped: false };
  });

  app.post<{ Params: { id: string } }>('/api/invocations/:id/retry', async (req) => {
    const inv = store.getInvocation(req.params.id);
    if (!inv) return { started: false };
    // Runs in the background; the outcome arrives as message events.
    const started = scheduler.retryInvocation(req.params.id);
    void started.catch(() => {});
    return { started: true };
  });

  app.get('/api/config', async () => publicConfig());

  app.put<{ Body: { triage?: TriageConfig | null; dsh?: { provider: string; model: string } | null } }>(
    '/api/config',
    async (req) => {
      const patch: Parameters<ConfigStore['update']>[0] = {};
      const b = req.body ?? {};
      if (b.triage === null) patch.triage = null;
      else if (b.triage && typeof b.triage.baseUrl === 'string' && typeof b.triage.model === 'string') {
        // An empty key keeps the stored one, so the UI can edit other fields without re-entering it.
        const apiKey = b.triage.apiKey || config.get().triage?.apiKey || '';
        patch.triage = { baseUrl: b.triage.baseUrl, model: b.triage.model, apiKey };
      }
      if (b.dsh === null) patch.dsh = null;
      else if (b.dsh && typeof b.dsh.provider === 'string' && typeof b.dsh.model === 'string') {
        patch.dsh = { provider: b.dsh.provider, model: b.dsh.model };
      }
      config.update(patch);
      return publicConfig();
    },
  );

  return app;
}
```

- [ ] **Step 4: 确认通过**

Run: `npx vitest run packages/hub/test/server.test.ts && npm run typecheck`
Expected: 13 个测试 PASS。

- [ ] **Step 5: 实现进程入口**

`packages/hub/src/main.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, CodexAdapter, DshAdapter, OpenCodeAdapter, dshModelPatch } from '@agent-chat/adapters';
import type { AgentAdapter, Availability } from '@agent-chat/adapters';
import { seed } from './bootstrap';
import { ConfigStore } from './config';
import { Scheduler } from './scheduler';
import { Bus, buildServer } from './server';
import { Store } from './store';
import { OpenAITriage } from './triage';

const dataDir = process.env.AGENTCHAT_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'AgentChat');
const port = Number(process.env.AGENTCHAT_PORT ?? 4317);

mkdirSync(dataDir, { recursive: true });
const config = new ConfigStore(dataDir);
const store = new Store(join(dataDir, 'agentchat.db'));
const bus = new Bus();

const dshPatchFile = join(dataDir, 'dsh-model.patch.yml');
const dshPatchPath = (): string | null => {
  const dsh = config.get().dsh;
  if (!dsh) return null;
  writeFileSync(dshPatchFile, dshModelPatch(dsh.provider, dsh.model));
  return dshPatchFile;
};

const adapterList: AgentAdapter[] = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new OpenCodeAdapter(),
  new DshAdapter({ patchPath: dshPatchPath }),
];
const adapters = new Map(adapterList.map((a) => [a.name, a]));
const availability = new Map<string, Availability>();

async function refreshAvailability(): Promise<void> {
  await Promise.all(
    adapterList.map(async (a) => {
      availability.set(a.name, await a.check().catch(() => ({ ok: false, reason: '检查失败' })));
    }),
  );
}

seed(store, adapterList);
const interrupted = store.markUnfinishedInterrupted();

const scheduler = new Scheduler({
  store,
  adapters,
  triage: () => {
    const t = config.get().triage;
    return t && t.apiKey ? new OpenAITriage(t) : null;
  },
  emit: (e) => bus.emit(e),
  dataDir,
  isAvailable: (name) => availability.get(name)?.ok ?? false,
});

const app = buildServer({ store, scheduler, config, bus, availability });

await refreshAvailability();
setInterval(() => void refreshAvailability(), 60000).unref();
await app.listen({ port, host: '127.0.0.1' });

console.log(`Agent Chat hub: http://127.0.0.1:${port}`);
console.log(`数据目录: ${dataDir}`);
console.log(`令牌保存在: ${join(dataDir, 'config.json')}`);
if (interrupted > 0) console.log(`上次有 ${interrupted} 次唤起未完成，已标记为中断。`);
for (const a of adapterList) {
  const s = availability.get(a.name)!;
  console.log(`  ${a.displayName}: ${s.ok ? '可用' : `不可用（${s.reason}）`}`);
}

const shutdown = async () => {
  scheduler.stopAll();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 6: 手动确认入口能启动**

Run: `AGENTCHAT_DATA_DIR="$(mktemp -d)" AGENTCHAT_PORT=4399 npx tsx packages/hub/src/main.ts`
Expected: 打印地址、数据目录和四个 agent 的可用状态（本机 Claude Code 预期显示"不可用（Claude Code 未登录…）"）。按 Ctrl+C 退出，进程应立即结束。

- [ ] **Step 7: 全量确认并提交**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS。

```bash
git add packages/hub
git commit -m "feat(hub): HTTP and WebSocket API, seed data, process entry"
```

---

### Task 12: 真实 agent 冒烟脚本与使用说明

**Files:**
- Create: `packages/hub/scripts/smoke.ts`, `README.md`

**Interfaces:**
- Consumes: 四个真实适配器、`dshModelPatch`。
- Produces: `npm run smoke -- <claude|codex|opencode|dsh>`，退出码 0 表示该 agent 通过：可用性检查、首次回复、续接会话后记得上文、只读（无法在工作目录创建文件）。

本任务会调用真实 agent 并产生少量费用，不属于自动测试。

- [ ] **Step 1: 写脚本**

`packages/hub/scripts/smoke.ts`:
```ts
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, CodexAdapter, DshAdapter, OpenCodeAdapter, dshModelPatch } from '@agent-chat/adapters';
import type { AgentAdapter, InvokeRequest } from '@agent-chat/adapters';

const which = process.argv[2];
const workdir = mkdtempSync(join(tmpdir(), `agentchat-smoke-${which}-`));

function makeAdapter(): AgentAdapter {
  switch (which) {
    case 'claude':
      return new ClaudeAdapter();
    case 'codex':
      return new CodexAdapter();
    case 'opencode':
      return new OpenCodeAdapter();
    case 'dsh': {
      // Optional model override: DSH_SMOKE_MODEL="provider|model"
      const override = process.env.DSH_SMOKE_MODEL;
      if (!override) return new DshAdapter();
      const [provider, model] = override.split('|');
      const patch = join(workdir, 'dsh-model.patch.yml');
      writeFileSync(patch, dshModelPatch(provider, model));
      return new DshAdapter({ patchPath: () => patch });
    }
    default:
      console.error('usage: npm run smoke -- <claude|codex|opencode|dsh>');
      process.exit(2);
  }
}

const adapter = makeAdapter();
let failed = false;
const report = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed = true;
};

const request = (sessionId: string | null, body: string): InvokeRequest => ({
  conversationId: 'smoke',
  agentName: adapter.displayName,
  conversationTitle: 'smoke',
  isGroup: false,
  harnessSessionId: sessionId,
  newMessages: [{ id: 'm', senderName: '我', body, createdAt: Date.now(), attachments: [] }],
  workdir,
  signal: new AbortController().signal,
  timeoutMs: 180000,
});

const availability = await adapter.check();
report(availability.ok, 'check()', availability.reason);
if (!availability.ok) process.exit(1);

try {
  const first = await adapter.invoke(request(null, '请记住这个暗号：蓝色河马。只回复"记住了"。'));
  report(first.kind === 'reply', '首次回复', first.kind === 'reply' ? first.body.slice(0, 60) : '');

  const second = await adapter.invoke(request(first.harnessSessionId, '我刚才让你记住的暗号是什么？'));
  const remembered = second.kind === 'reply' && second.body.includes('蓝色河马');
  report(remembered, '续接会话后记得上文', second.kind === 'reply' ? second.body.slice(0, 60) : '');

  const marker = join(workdir, 'SHOULD_NOT_EXIST.txt');
  await adapter
    .invoke(request(second.harnessSessionId, '请在当前目录创建文件 SHOULD_NOT_EXIST.txt，内容为 x。'))
    .catch(() => undefined);
  report(!existsSync(marker), '只读：无法在工作目录创建文件');
} catch (e) {
  report(false, '调用出错', (e as Error).message);
}

console.log(`工作目录: ${workdir}`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: 逐个运行**

Run: `npm run smoke -- codex`
Expected: 四行 PASS，退出码 0。

Run: `npm run smoke -- opencode`
Expected: 四行 PASS。

Run: `DSH_SMOKE_MODEL="my-provider|my-provider/deepseek-flash" npm run smoke -- dsh`
Expected: 四行 PASS。（不带 `DSH_SMOKE_MODEL` 时，本机会因 headless 配置的默认模型指向未注册的 provider 而失败，属预期。）

Run: `npm run smoke -- claude`
Expected: 本机当前为 `FAIL  check()  — Claude Code 未登录：请在终端运行 claude 并执行 /login`。用户登录后重跑应四行 PASS。

处理失败的规则：
- "只读"一项失败：该适配器的只读参数不起作用。先看该命令的 `--help` 确认参数，再修改对应的 `*Args` 函数及其测试，重跑自动测试和冒烟。不得删除这一项检查。
- "续接"一项失败：检查对应 `parse*` 函数取到的会话 ID 是否与命令行输出一致，按实际输出修正解析及其测试用的事件样例。
- Claude Code 登录后若"首次回复"失败：把实际的标准输出保存下来，对照 `parseClaude` 修正，并把真实输出补进 `claude.test.ts`。

- [ ] **Step 3: 写使用说明**

`README.md`:
````markdown
# Agent Chat

本机聊天应用的后端：人和多个 agent（Claude Code、Codex、OpenCode、DSH）在同一处私聊和群聊。

设计文档见 `docs/superpowers/specs/`。

## 运行

需要 Node 22.13 或更高版本。

```bash
npm install
npm run hub
```

中枢监听 `http://127.0.0.1:4317`，只接受本机连接。数据在 `~/Library/Application Support/AgentChat/`，访问令牌在其中的 `config.json`。

环境变量：`AGENTCHAT_PORT` 改端口，`AGENTCHAT_DATA_DIR` 改数据目录。

## 各 agent 的前提

| agent | 前提 |
|---|---|
| Claude Code | 已安装 `claude`，并在终端里运行 `claude` 执行过 `/login` |
| Codex | 已安装并登录 `codex` |
| OpenCode | 已安装并配置好 `opencode` |
| DSH | 已安装 `dsh`；如果 headless 配置的默认模型不可用，在设置里指定 provider 和 model |

启动时会打印每个 agent 是否可用及原因。

## 设置

设置通过 `PUT /api/config` 写入：

- `triage`：群聊里决定谁发言的小模型，任意 OpenAI 兼容接口，`{ baseUrl, apiKey, model }`。不配置时，群里只有被 @ 的 agent 会回复。
- `dsh`：DSH 使用的模型，`{ provider, model }`。

## 测试

```bash
npm test                       # 自动测试，不调用真实 agent
npm run smoke -- codex         # 手动冒烟，会调用真实 agent 并产生费用
```

`smoke` 可选 `claude`、`codex`、`opencode`、`dsh`。DSH 可用 `DSH_SMOKE_MODEL="provider|model"` 指定模型。
````

- [ ] **Step 4: 端到端手动验证**

启动中枢：`npm run hub`（保持运行），另开一个终端：

```bash
DATA="$HOME/Library/Application Support/AgentChat"
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).token)" "$DATA/config.json")
H="Authorization: Bearer $TOKEN"
curl -s -H "$H" -X PUT -H 'content-type: application/json' \
  -d '{"dsh":{"provider":"my-provider","model":"my-provider/deepseek-flash"}}' http://127.0.0.1:4317/api/config
curl -s -H "$H" http://127.0.0.1:4317/api/state | node -e "const s=JSON.parse(require('fs').readFileSync(0,'utf8'));for(const c of s.conversations)console.log(c.id,c.kind,c.title)"
```

取 Codex 私聊的 id 记为 `$DM`：

```bash
curl -s -H "$H" -H 'content-type: application/json' -d '{"body":"用一句话介绍你自己"}' http://127.0.0.1:4317/api/conversations/$DM/messages
sleep 60
curl -s -H "$H" "http://127.0.0.1:4317/api/conversations/$DM/messages"
```

Expected: 消息列表里有 Codex 的一条回复。

建一个含 Codex 和 OpenCode 的群（成员 id 取自 `/api/state`），发 `@Codex 你好`，等待后查看消息列表。
Expected: Codex 回复；未配置点名模型时 OpenCode 不发言。

- [ ] **Step 5: Commit**

```bash
git add packages/hub/scripts README.md
git commit -m "feat: real-agent smoke script and README"
```

---

## 本计划之后

- **第一期 B：网页界面**。React 界面连接本计划的 HTTP 和 WebSocket 接口，包含 Playwright 端到端测试。在本计划完成、接口定型后单独写计划。
- 规格第 10 节的完成标准中，"能与四个 agent 分别私聊""群里相互接话""到轮数上限停下""暂停和全局停止立即生效""无法修改工作目录以外的文件""自动测试全部通过"由本计划的 Task 9 至 12 覆盖；界面相关的体验由第一期 B 覆盖。
