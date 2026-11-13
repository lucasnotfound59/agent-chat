# Agent Chat 网页界面（最小版）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Agent Chat 做一个能实际使用的网页界面：hub 在同一端口提供网页，启动时自动打开浏览器，支持私聊、群聊、agent 互问（含人插话）、@、正在输入、暂停与全部停止、可用状态刷新。

**Architecture:** 后端（`packages/hub`）先补五项能力：可用状态监视与刷新、提供静态网页并打开浏览器、WebSocket 的 Origin 检查与 `/api/state` 的 `lastMessage`、人在 ask 会话里插话、停止或暂停时不丢问题。前端是新包 `packages/web`（React + Vite），构建成静态文件由 hub 提供；状态集中在一个纯函数 reducer 里，HTTP 和 WebSocket 各一个小模块，组件每个文件只做一件事。端到端用 Playwright 跑一个只有假 adapter 的 hub。

**Tech Stack:** TypeScript、Node ≥ 22.13、Fastify 5 + @fastify/websocket（已有）、React 18.3.1、Vite 5.4.21、@vitejs/plugin-react 4.7.0、react-markdown 9.1.0、rehype-highlight 7.0.2、vitest 2（已有）+ jsdom 25.0.1 + @testing-library/react 16.3.3、@playwright/test 1.62.1。

**Spec:** `docs/superpowers/specs/2026-11-13-agent-chat-web-ui-design.md`

## Global Constraints

- 自动测试一律不得调用真实 agent CLI、真实网络、真实 keychain、真实浏览器；所有 vitest project 都挂 `test/guard.ts`（本计划给它加上 `open` 的假脚本）。
- 不得修改用户的全局配置（`~/.codex`、`~/.claude*`、`~/.config/opencode`、`~/.dsh`），不得运行 `npm run connect -- --apply` 或 `disconnect -- --apply`。
- 不得把 hub token 打印到你自己的输出或写进任何文件：手工启动真实 hub 时一律 `AGENTCHAT_NO_OPEN=1 npm run hub > <临时文件> 2>&1`，不要 `cat` 这个文件里含 `#token=` 的行。
- 仓库是公开的：已跟踪文件里不得出现本机个人信息（home 绝对路径、用户名、主机名、私有 provider 名、npm 镜像地址）。每次 `npm install` 之后，如果本机 npm 配置的是镜像源，要把 `package-lock.json` 里的下载地址改回 `https://registry.npmjs.org/`，并确认 `grep '"resolved"' package-lock.json | grep -vc 'https://registry.npmjs.org/'` 输出 `0`。
- 界面文案用中文，技术名词保留英文。
- 真实 agent 调用会花用户的额度：本计划只有 Task 14 的人工验收需要一次，执行前必须先征得用户同意。
- 每个任务结束 commit 一次，commit message 末尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不得 push 或合并，除非用户明确要求。
- 依赖版本固定为上面 Tech Stack 里写的精确版本。

---

### Task 1: 可用状态监视器与刷新接口（并给测试防线加上 `open`）

**Files:**
- Modify: `test/guard.ts`（shim 列表加 `open`）
- Create: `packages/hub/src/availability.ts`
- Modify: `packages/hub/src/types.ts`（`HubEvent` 加 `availability`）
- Modify: `packages/hub/src/server.ts`（`ServerDeps.refreshAvailability`、`POST /api/availability/refresh`）
- Modify: `packages/hub/src/main.ts`（用 `AvailabilityMonitor` 取代手写的 map 和 `refreshAvailability`）
- Test: `packages/hub/test/availability.test.ts`（新建）、`packages/hub/test/server.test.ts`

**Interfaces:**
- Produces: `class AvailabilityMonitor { readonly map: Map<string, Availability>; constructor(adapters: AgentAdapter[], emit: (e: HubEvent) => void); refresh(): Promise<void> }`；`HubEvent` 新增 `{ type: 'availability'; adapter: string; availability: Availability }`；`ServerDeps.refreshAvailability: () => Promise<void>`；`POST /api/availability/refresh` 返回 `Record<adapterName, Availability>`。

- [ ] **Step 1: 给测试防线加 `open`**

在 `test/guard.ts` 里把这一行：

```ts
for (const name of ['codex', 'claude', 'opencode', 'dsh', 'security']) {
```

改成（`open` 是 macOS 打开浏览器的命令，hub 启动时会调用它）：

```ts
// `open` launches the default browser; the hub calls it on start-up.
for (const name of ['codex', 'claude', 'opencode', 'dsh', 'security', 'open']) {
```

- [ ] **Step 2: 写失败的测试**

新建 `packages/hub/test/availability.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { FakeAdapter } from '@agent-chat/adapters';
import { AvailabilityMonitor } from '../src/availability';
import type { HubEvent } from '../src/types';

describe('AvailabilityMonitor', () => {
  it('fills the map and emits an availability event only when something changed', async () => {
    const a = new FakeAdapter('fake-a', 'A');
    const b = new FakeAdapter('fake-b', 'B');
    b.availability = { ok: false, reason: '未登录' };
    const events: HubEvent[] = [];
    const m = new AvailabilityMonitor([a, b], (e) => events.push(e));

    await m.refresh();
    expect(m.map.get('fake-a')).toEqual({ ok: true });
    expect(m.map.get('fake-b')).toEqual({ ok: false, reason: '未登录' });
    expect(events).toHaveLength(2);

    await m.refresh();
    expect(events).toHaveLength(2);

    b.availability = { ok: true };
    await m.refresh();
    expect(events.slice(2)).toEqual([{ type: 'availability', adapter: 'fake-b', availability: { ok: true } }]);
  });

  it('counts a failing check as unavailable', async () => {
    const a = new FakeAdapter('fake-a', 'A');
    a.check = async () => {
      throw new Error('boom');
    };
    const m = new AvailabilityMonitor([a], () => {});
    await m.refresh();
    expect(m.map.get('fake-a')).toEqual({ ok: false, reason: '检查失败' });
  });

  it('lets concurrent refreshes share one round of checks', async () => {
    const a = new FakeAdapter('fake-a', 'A');
    let checks = 0;
    a.check = async () => {
      checks++;
      return { ok: true };
    };
    const m = new AvailabilityMonitor([a], () => {});
    await Promise.all([m.refresh(), m.refresh()]);
    expect(checks).toBe(1);
  });
});
```

在 `packages/hub/test/server.test.ts` 里：

1. 在顶部的 `let auth: { authorization: string };` 下面加一行 `let refreshCalls = 0;`。
2. 在 `beforeEach` 开头加 `refreshCalls = 0;`。
3. 把 `beforeEach` 里的 `app = buildServer({ store, scheduler, config, token: () => tokenStore.get()!, bus, availability, ask });` 改成：

```ts
  app = buildServer({
    store,
    scheduler,
    config,
    token: () => tokenStore.get()!,
    bus,
    availability,
    ask,
    refreshAvailability: async () => {
      refreshCalls++;
    },
  });
```

4. 在 `describe('settings, stop and config', () => {` 这个 describe 的末尾（它的最后一个 `});` 之前）加：

```ts
  it('POST /api/availability/refresh re-checks and returns every adapter', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/availability/refresh' })).statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/api/availability/refresh', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(refreshCalls).toBe(1);
    expect(r.json()).toEqual({ 'fake-a': { ok: true }, 'fake-b': { ok: false, reason: '未登录' } });
  });
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npx vitest run packages/hub/test/availability.test.ts packages/hub/test/server.test.ts`
Expected: FAIL，`availability.test.ts` 报找不到 `../src/availability`；`server.test.ts` 的新用例 404。

- [ ] **Step 4: 实现**

新建 `packages/hub/src/availability.ts`：

```ts
import type { AgentAdapter, Availability } from '@agent-chat/adapters';
import type { HubEvent } from './types';

/** Holds each adapter's availability; `refresh()` re-checks all and emits one event per change. */
export class AvailabilityMonitor {
  readonly map = new Map<string, Availability>();
  private running: Promise<void> | null = null;

  constructor(
    private readonly adapters: AgentAdapter[],
    private readonly emit: (e: HubEvent) => void,
  ) {}

  /** Concurrent callers share one round of checks. */
  refresh(): Promise<void> {
    this.running ??= this.checkAll().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async checkAll(): Promise<void> {
    await Promise.all(
      this.adapters.map(async (a) => {
        const next = await a.check().catch((): Availability => ({ ok: false, reason: '检查失败' }));
        const prev = this.map.get(a.name);
        this.map.set(a.name, next);
        if (!prev || prev.ok !== next.ok || (prev.reason ?? '') !== (next.reason ?? '')) {
          this.emit({ type: 'availability', adapter: a.name, availability: next });
        }
      }),
    );
  }
}
```

在 `packages/hub/src/types.ts` 顶部加 `import type { Availability } from '@agent-chat/adapters';`，并把 `HubEvent` 改成：

```ts
export type HubEvent =
  | { type: 'message'; message: Message }
  | { type: 'typing'; conversationId: string; memberId: string; active: boolean }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'stopped'; stopped: boolean }
  | { type: 'availability'; adapter: string; availability: Availability };
```

在 `packages/hub/src/server.ts` 的 `ServerDeps` 里 `ask: AskService;` 下面加：

```ts
  /** Re-checks every adapter (the hub's AvailabilityMonitor.refresh). */
  refreshAvailability: () => Promise<void>;
```

在 `app.post('/api/stop', ...)` 之前加：

```ts
  app.post('/api/availability/refresh', async () => {
    await deps.refreshAvailability();
    return Object.fromEntries(availability);
  });
```

在 `packages/hub/src/main.ts`：
1. 加 `import { AvailabilityMonitor } from './availability';`。
2. 删掉 `const availability = new Map<string, Availability>();` 和整个 `async function refreshAvailability() {...}`，换成：

```ts
const monitor = new AvailabilityMonitor(adapterList, (e) => bus.emit(e));
const availability = monitor.map;
```

3. 把 `buildServer({ store, scheduler, config, token: () => token, bus, availability, ask })` 改成 `buildServer({ store, scheduler, config, token: () => token, bus, availability, ask, refreshAvailability: () => monitor.refresh() })`。
4. 把 `await refreshAvailability();` 改成 `await monitor.refresh();`，`setInterval(() => void refreshAvailability(), 60000).unref();` 改成 `setInterval(() => void monitor.refresh(), 60000).unref();`。
5. 如果 `Availability` 的 type import 不再使用，从 import 里删掉它。

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS，typecheck 无输出错误。

- [ ] **Step 6: Commit**

```bash
git add test/guard.ts packages/hub/src/availability.ts packages/hub/src/types.ts packages/hub/src/server.ts packages/hub/src/main.ts packages/hub/test/availability.test.ts packages/hub/test/server.test.ts
git commit -m "feat(hub): availability monitor with a refresh route and availability events; guard shims open" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: hub 提供网页，启动时打开浏览器

**Files:**
- Create: `packages/hub/src/web.ts`、`packages/hub/src/open.ts`
- Modify: `packages/hub/src/server.ts`（`ServerDeps.webRoot?`、鉴权豁免、注册网页路由）
- Modify: `packages/hub/src/main.ts`（传 `webRoot`，启动后打印并打开地址）
- Test: `packages/hub/test/web.test.ts`、`packages/hub/test/open.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `ServerDeps.refreshAvailability`。
- Produces: `registerWeb(app: FastifyInstance, webRoot: string): void`、`WEB_ROUTES: Set<string>`（`'/'`、`'/*'`）、`MISSING_BUILD_PAGE: string`；`webUrl(port: number, token: string): string`；`openBrowser(url: string, env: NodeJS.ProcessEnv, run?: (cmd: string, args: string[]) => void): boolean`；`ServerDeps.webRoot?: string`。

- [ ] **Step 1: 写失败的测试**

新建 `packages/hub/test/open.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { openBrowser, webUrl } from '../src/open';

describe('webUrl / openBrowser', () => {
  it('puts the token in the fragment, URL-encoded', () => {
    expect(webUrl(4317, 'a+b/c')).toBe('http://127.0.0.1:4317/#token=a%2Bb%2Fc');
  });

  it('runs `open` with the URL', () => {
    const calls: Array<[string, string[]]> = [];
    expect(openBrowser('http://x/', {}, (cmd, args) => calls.push([cmd, args]))).toBe(true);
    expect(calls).toEqual([['open', ['http://x/']]]);
  });

  it('does nothing when AGENTCHAT_NO_OPEN=1', () => {
    const calls: unknown[] = [];
    expect(openBrowser('http://x/', { AGENTCHAT_NO_OPEN: '1' }, () => calls.push(1))).toBe(false);
    expect(calls).toEqual([]);
  });
});
```

新建 `packages/hub/test/web.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter } from '@agent-chat/adapters';
import { AskService } from '../src/ask';
import { seed } from '../src/bootstrap';
import { ConfigStore } from '../src/config';
import { Scheduler } from '../src/scheduler';
import { Bus, buildServer } from '../src/server';
import { Store } from '../src/store';

function makeApp(webRoot?: string) {
  const store = new Store(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'agentchat-web-'));
  const fa = new FakeAdapter('fake-a', 'A');
  seed(store, [fa]);
  const bus = new Bus();
  const scheduler = new Scheduler({
    store,
    adapters: new Map([[fa.name, fa]]),
    triage: () => null,
    emit: (e) => bus.emit(e),
    dataDir,
    isAvailable: () => true,
  });
  const ask = new AskService({ store, scheduler, isAvailable: () => true, availabilityReason: () => undefined, emit: (e) => bus.emit(e) });
  return buildServer({
    store,
    scheduler,
    config: new ConfigStore(dataDir),
    token: () => 'tok',
    bus,
    availability: new Map([['fake-a', { ok: true }]]),
    ask,
    refreshAvailability: async () => {},
    webRoot,
  });
}

function builtWeb(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentchat-dist-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root">INDEX</div>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app-123.js'), 'console.log(1)');
  return root;
}

describe('web UI files', () => {
  it('serves index.html and assets without a token, and keeps /api behind the token', async () => {
    const app = makeApp(builtWeb());
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(index.body).toContain('INDEX');

    const js = await app.inject({ method: 'GET', url: '/assets/app-123.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
    expect(js.headers['cache-control']).toContain('immutable');

    expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
  });

  it('falls back to index.html for unknown pages and never leaves the web root', async () => {
    const app = makeApp(builtWeb());
    expect((await app.inject({ method: 'GET', url: '/some/page' })).body).toContain('INDEX');
    const escape = await app.inject({ method: 'GET', url: '/%2e%2e/%2e%2e/package.json' });
    expect(escape.body).toContain('INDEX');
    expect(escape.body).not.toContain('"name"');
  });

  it('answers unknown /api paths with a JSON 404, not the page', async () => {
    const app = makeApp(builtWeb());
    const r = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not found' });
  });

  it('still checks the Host header', async () => {
    const app = makeApp(builtWeb());
    expect((await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } })).statusCode).toBe(403);
  });

  it('shows a build hint when the web UI has not been built', async () => {
    const app = makeApp(mkdtempSync(join(tmpdir(), 'agentchat-empty-')));
    const r = await app.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(503);
    expect(r.body).toContain('npm run build');
  });

  it('exposes nothing without a web root', async () => {
    const app = makeApp(undefined);
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/hub/test/web.test.ts packages/hub/test/open.test.ts`
Expected: FAIL，找不到 `../src/open`；`web.test.ts` 的请求都是 401。

- [ ] **Step 3: 实现**

新建 `packages/hub/src/open.ts`：

```ts
import { execFile } from 'node:child_process';

/** The address that hands the browser its token; the fragment never reaches the server or its logs. */
export function webUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`;
}

type Run = (cmd: string, args: string[]) => void;

const defaultRun: Run = (cmd, args) => {
  execFile(cmd, args, (err) => {
    if (err) console.error(`[web] 无法自动打开浏览器：${err.message}`);
  });
};

/** Opens `url` in the default browser unless AGENTCHAT_NO_OPEN=1. Returns whether it tried. */
export function openBrowser(url: string, env: NodeJS.ProcessEnv, run: Run = defaultRun): boolean {
  if (env.AGENTCHAT_NO_OPEN === '1') return false;
  run('open', [url]);
  return true;
}
```

新建 `packages/hub/src/web.ts`：

```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** Routes that serve the web UI; the auth hook lets them through (they hold no secrets). */
export const WEB_ROUTES = new Set(['/', '/*']);

export const MISSING_BUILD_PAGE =
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Agent Chat</title>' +
  '<p>界面还没有构建。请在仓库目录运行 <code>npm run build</code>，然后刷新本页。</p></html>';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Serves the built UI from `webRoot`; unknown pages fall back to index.html. */
export function registerWeb(app: FastifyInstance, webRoot: string): void {
  const root = resolve(webRoot);
  const index = join(root, 'index.html');

  const send = (rel: string, reply: FastifyReply) => {
    if (!existsSync(index)) return reply.code(503).type('text/html; charset=utf-8').send(MISSING_BUILD_PAGE);
    let full = resolve(root, rel);
    if (!full.startsWith(root + sep) || !isFile(full)) full = index;
    const immutable = full !== index && rel.startsWith('assets/');
    return reply
      .type(TYPES[extname(full)] ?? 'application/octet-stream')
      .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(readFileSync(full));
  };

  app.get('/', async (_req, reply) => send('index.html', reply));
  app.get<{ Params: { '*': string } }>('/*', async (req, reply) => {
    const rel = req.params['*'];
    if (rel === 'api' || rel.startsWith('api/') || rel === 'ws') return reply.code(404).send({ error: 'not found' });
    return send(rel, reply);
  });
}
```

在 `packages/hub/src/server.ts`：
1. 加 `import { WEB_ROUTES, registerWeb } from './web';`。
2. `ServerDeps` 加一项：

```ts
  /** Directory of the built web UI (packages/web/dist); omitted in tests that do not need it. */
  webRoot?: string;
```

3. 鉴权 hook 里把 `if (req.routeOptions.url === '/ws') return;` 改成：

```ts
    if (req.routeOptions.url === '/ws') return;
    if (deps.webRoot !== undefined && WEB_ROUTES.has(req.routeOptions.url ?? '')) return;
```

4. 在 `return app;` 之前加：

```ts
  if (deps.webRoot !== undefined) registerWeb(app, deps.webRoot);
```

在 `packages/hub/src/main.ts`：
1. 加 `import { dirname, join, resolve } from 'node:path';`（合并到已有的 `node:path` import）、`import { fileURLToPath } from 'node:url';`、`import { openBrowser, webUrl } from './open';`。
2. `buildServer({...})` 里加 `webRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),`。
3. 在打印各 agent 可用状态的 `for` 循环之后加：

```ts
const url = webUrl(port, token);
console.log(`界面：${url}`);
console.log('（这个地址里含访问令牌，不要发给别人）');
if (openBrowser(url, process.env)) console.log('已在默认浏览器中打开。设置 AGENTCHAT_NO_OPEN=1 可以不自动打开。');
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/web.ts packages/hub/src/open.ts packages/hub/src/server.ts packages/hub/src/main.ts packages/hub/test/web.test.ts packages/hub/test/open.test.ts
git commit -m "feat(hub): serve the built web UI without auth and open it with the token in the fragment" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: WebSocket 的 Origin 检查、`/api/state` 的 `lastMessage`、`conversation` 事件的测试

**Files:**
- Modify: `packages/hub/src/server.ts`（`/ws` 握手、`/api/state`）
- Test: `packages/hub/test/server.test.ts`

**Interfaces:**
- Produces: `/ws` 对带 `Origin` 且不等于 `http://<Host>` 的连接以 4003 关闭；`/api/state` 的 `conversations[i]` 多一个 `lastMessage: Message | null`。

- [ ] **Step 1: 写失败的测试**

在 `packages/hub/test/server.test.ts` 的 `describe('websocket', () => {` 里，现有 `it` 之后加：

```ts
  it('rejects a browser connection from another origin, accepts its own origin', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const evil = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: 'http://evil.example' } });
    const code = await new Promise<number>((r) => evil.on('close', (c) => r(c)));
    expect(code).toBe(4003);

    const own = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const got: any[] = [];
    own.on('message', (d) => got.push(JSON.parse(d.toString())));
    await new Promise((r) => own.on('open', r));
    own.send(JSON.stringify({ type: 'auth', token }));
    await until(() => got.some((e) => e.type === 'ready'));
    own.close();
  });

  it('pushes a conversation event for a new group and for a settings change', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const got: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'auth', token }));
    await until(() => got.some((e) => e.type === 'ready'));

    const s = await state();
    const a = s.members.find((m: any) => m.name === 'A');
    const created = await app.inject({ method: 'POST', url: '/api/conversations', headers: auth, payload: { title: 'G1', memberIds: [a.id] } });
    const id = created.json().id;
    await until(() => got.some((e) => e.type === 'conversation' && e.conversation.id === id));
    await app.inject({ method: 'PATCH', url: `/api/conversations/${id}/settings`, headers: auth, payload: { paused: true } });
    await until(() => got.some((e) => e.type === 'conversation' && e.conversation.id === id && e.conversation.settings.paused));
    ws.close();
  });
```

在 `describe('state', () => {` 里加：

```ts
  it('includes each conversation\'s last message', async () => {
    const s = await state();
    const a = s.members.find((m: any) => m.name === 'A');
    const g = (await app.inject({ method: 'POST', url: '/api/conversations', headers: auth, payload: { title: 'G2', memberIds: [a.id] } })).json();
    expect((await state()).conversations.find((c: any) => c.id === g.id).lastMessage).toBeNull();
    // no @mention and no triage in this fixture, so nobody answers
    await app.inject({ method: 'POST', url: `/api/conversations/${g.id}/messages`, headers: auth, payload: { body: '大家好' } });
    expect((await state()).conversations.find((c: any) => c.id === g.id).lastMessage).toMatchObject({ body: '大家好' });
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/hub/test/server.test.ts`
Expected: FAIL：Origin 用例收到的关闭码不是 4003（连接一直开着，测试超时或等到别的码）；`lastMessage` 用例是 `undefined`。`conversation` 事件用例应当已经 PASS（现有代码已推送，这是补测试）。

- [ ] **Step 3: 实现**

在 `packages/hub/src/server.ts` 的 `/ws` 路由里，把 `ws.get('/ws', { websocket: true }, (socket) => {` 改成：

```ts
    ws.get('/ws', { websocket: true }, (socket, req) => {
      // A browser always sends Origin; another site's page must not reach the event stream.
      const origin = req.headers.origin;
      if (origin !== undefined && origin.toLowerCase() !== `http://${(req.headers.host ?? '').toLowerCase()}`) {
        socket.close(4003, 'forbidden origin');
        return;
      }
```

（函数体其余部分不变。）

把 `/api/state` 里的 `conversations: store.listConversations(),` 改成：

```ts
    conversations: store.listConversations().map((c) => ({ ...c, lastMessage: store.listMessages(c.id, { limit: 1 })[0] ?? null })),
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/server.ts packages/hub/test/server.test.ts
git commit -m "feat(hub): websocket rejects other origins; /api/state carries each conversation's last message" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 人在 ask 会话里插话

**Files:**
- Modify: `packages/hub/src/store.ts`（`askTarget`）
- Modify: `packages/hub/src/scheduler.ts`（`buildRequest` 的发言人名字、`answerInAsk`）
- Modify: `packages/hub/src/server.ts`（发消息路由允许 ask 会话）
- Test: `packages/hub/test/ask.test.ts`、`packages/hub/test/server.test.ts`

**Interfaces:**
- Produces: `Store.askTarget(conversationId: string): string | null`；`Scheduler.answerInAsk(msg: Message): Promise<void>`。

- [ ] **Step 1: 写失败的测试**

在 `packages/hub/test/ask.test.ts` 末尾加：

```ts
describe('a human message in an ask conversation', () => {
  it('is answered by the answerer in its existing session, which sees the human by name', async () => {
    const t = make();
    t.fa.handler = async () => ({ kind: 'reply', body: '第一答', harnessSessionId: 'sess-1' });
    await t.ask({ question: '第一问' });
    const conv = t.askConvs()[0];
    t.fa.handler = async () => ({ kind: 'reply', body: '收到', harnessSessionId: 'sess-1' });
    const m = t.store.addMessage({ conversationId: conv.id, senderId: t.human.id, body: '补充一句' });
    await t.scheduler.answerInAsk(m);
    expect(t.fa.calls[1].harnessSessionId).toBe('sess-1');
    expect(t.fa.calls[1].newMessages.map((x) => [x.senderName, x.body])).toEqual([['我', '补充一句']]);
    expect(t.store.listMessages(conv.id).at(-1)).toMatchObject({ senderId: t.a.id, body: '收到' });
    expect(t.store.listInvocations(conv.id).map((i) => i.reason)).toEqual(['ask', 'ask']);
  });

  it('ignores agent messages there', async () => {
    const t = make();
    await t.ask({});
    const conv = t.askConvs()[0];
    const m = t.store.addMessage({ conversationId: conv.id, senderId: t.b.id, body: '我自己说一句' });
    await t.scheduler.answerInAsk(m);
    expect(t.fa.calls).toHaveLength(1);
  });

  it('explains in a system message why nothing was answered when the hub is stopped', async () => {
    const t = make();
    await t.ask({});
    const conv = t.askConvs()[0];
    t.scheduler.stopAll();
    const m = t.store.addMessage({ conversationId: conv.id, senderId: t.human.id, body: '在吗' });
    await t.scheduler.answerInAsk(m);
    expect(t.fa.calls).toHaveLength(1);
    expect(t.store.listMessages(conv.id).at(-1)).toMatchObject({ kind: 'system', body: '已全局停止，这条消息没有被处理。' });
  });

  it('explains a silent answerer', async () => {
    const t = make();
    await t.ask({});
    const conv = t.askConvs()[0];
    t.fa.handler = async () => ({ kind: 'silent', harnessSessionId: 's' });
    const m = t.store.addMessage({ conversationId: conv.id, senderId: t.human.id, body: '在吗' });
    await t.scheduler.answerInAsk(m);
    expect(t.store.listMessages(conv.id).at(-1)).toMatchObject({ kind: 'system', body: 'A 没有回答。' });
  });
});
```

在 `packages/hub/test/server.test.ts` 的 `describe('ask routes', () => {` 末尾加：

```ts
  it('accepts a human message in an ask conversation and the answerer replies', async () => {
    expect((await post(good)).statusCode).toBe(200);
    const conv = store.listConversations().find((c) => c.kind === 'ask')!;
    const r = await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/messages`, headers: auth, payload: { body: '我来补充' } });
    expect(r.statusCode).toBe(200);
    await until(() => store.listMessages(conv.id).filter((m) => m.body === 'reply from A').length === 2);
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/hub/test/ask.test.ts packages/hub/test/server.test.ts`
Expected: FAIL：`t.scheduler.answerInAsk is not a function`；server 用例收到 400。

- [ ] **Step 3: 实现**

在 `packages/hub/src/store.ts` 的 `findAskConversation` 之后加：

```ts
  /** The member an `ask` conversation was asked of, or null for any other conversation. */
  askTarget(conversationId: string): string | null {
    const r = this.db.prepare("SELECT ask_to FROM conversations WHERE id = ? AND kind = 'ask'").get(conversationId);
    return (r?.ask_to as string | null | undefined) ?? null;
  }
```

在 `packages/hub/src/scheduler.ts` 的 `buildRequest` 里，把：

```ts
    const nameOf = (id: string | null) => members.find((m) => m.id === id)?.name ?? '系统';
```

改成（人不是 ask 会话的成员，要按全部成员查）：

```ts
    const nameOf = (id: string | null) =>
      members.find((m) => m.id === id)?.name ?? (id ? store.getMember(id)?.name : undefined) ?? '系统';
```

在 `invokeForAsk` 方法之后加：

```ts
  /**
   * A human message in an `ask` conversation: the answerer replies in its existing session, queued
   * with MCP asks on the same conversation. Agent messages there never trigger anything.
   */
  async answerInAsk(msg: Message): Promise<void> {
    const { store } = this.deps;
    const sender = msg.senderId ? store.getMember(msg.senderId) : null;
    const targetId = store.askTarget(msg.conversationId);
    if (msg.kind !== 'normal' || sender?.kind !== 'human' || !targetId) return;
    const r = await this.invokeForAsk(msg.conversationId, targetId, new AbortController().signal, msg.seq);
    const name = store.getMember(targetId)?.name ?? '对方';
    // Timeouts and errors already got a system message from execute().
    if (r.kind === 'stopped') this.system(msg.conversationId, '已全局停止，这条消息没有被处理。');
    else if (r.kind === 'capped') this.system(msg.conversationId, `${r.message}，这条消息没有被处理。`);
    else if (r.kind === 'silent') this.system(msg.conversationId, `${name} 没有回答。`);
    else if (r.kind === 'aborted') this.system(msg.conversationId, `${name} 的回答被中止了。`);
  }
```

在 `packages/hub/src/server.ts` 的 `POST /api/conversations/:id/messages` 里：
1. 删掉 `if (conv.kind === 'ask') return reply.code(400).send({ error: '提问会话暂不支持手动发言' });`。
2. 把末尾的

```ts
      scheduler.onMessage(message);
      bus.emit({ type: 'message', message });
      return message;
```

改成：

```ts
      bus.emit({ type: 'message', message });
      if (conv.kind === 'ask') void scheduler.answerInAsk(message).catch((err) => console.error('[ask] answer failed', err));
      else scheduler.onMessage(message);
      return message;
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/store.ts packages/hub/src/scheduler.ts packages/hub/src/server.ts packages/hub/test/ask.test.ts packages/hub/test/server.test.ts
git commit -m "feat(hub): a human can speak in an ask conversation; the answerer replies through the ask queue" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 停止或暂停时不丢问题（第一期遗留 I3）

**Files:**
- Modify: `packages/hub/src/scheduler.ts`（`runRound`）
- Test: `packages/hub/test/scheduler-limits.test.ts`

**Interfaces:**
- Produces: 行为变化：回合被打断且无人答完时，触发消息恢复为未处理。

- [ ] **Step 1: 写失败的测试**

在 `packages/hub/test/scheduler-limits.test.ts` 末尾加（文件顶部已有 `beforeEach(() => vi.useFakeTimers())` 和 `hang`）：

```ts
describe('an interrupted round does not lose the question', () => {
  const answer = async () => ({ kind: 'reply' as const, body: '答', harnessSessionId: 's' });

  it('pausing mid-answer, then resuming, asks again', async () => {
    const t = setup();
    t.fa.handler = hang;
    t.say(t.dm.id, '问题');
    await vi.advanceTimersByTimeAsync(10);
    expect(t.fa.calls).toHaveLength(1);
    t.store.updateSettings(t.dm.id, { paused: true });
    t.scheduler.abortConversation(t.dm.id);
    await t.settle();
    t.fa.handler = answer;
    t.store.updateSettings(t.dm.id, { paused: false });
    t.scheduler.kick(t.dm.id);
    await t.settle();
    expect(t.fa.calls).toHaveLength(2);
    expect(t.bodies(t.dm.id)).toContain('答');
  });

  it('stopping all mid-answer, then resuming, asks again', async () => {
    const t = setup();
    t.fa.handler = hang;
    t.say(t.dm.id, '问题');
    await vi.advanceTimersByTimeAsync(10);
    t.scheduler.stopAll();
    await t.settle();
    t.fa.handler = answer;
    t.scheduler.resumeAll();
    await t.settle();
    expect(t.fa.calls).toHaveLength(2);
    expect(t.bodies(t.dm.id)).toContain('答');
  });

  it('does not ask again when an agent already answered in that round', async () => {
    const t = setup({ settings: { maxAgentRounds: 0 } });
    t.fa.handler = answer;
    t.fb.handler = hang;
    t.say(t.group.id, '@A @B 看看', [t.a.id, t.b.id]);
    await t.settle();
    expect(t.fa.calls).toHaveLength(1);
    expect(t.fb.calls).toHaveLength(1);
    t.scheduler.stopAll();
    await t.settle();
    t.fb.handler = answer;
    t.scheduler.resumeAll();
    await t.settle();
    expect(t.fa.calls).toHaveLength(1);
    expect(t.fb.calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/hub/test/scheduler-limits.test.ts -t "does not lose the question"`
Expected: 前两个 FAIL（`fa.calls` 长度为 1），第三个 PASS。

- [ ] **Step 3: 实现**

在 `packages/hub/src/scheduler.ts` 的 `runRound` 里：

1. 在 `const pending = store.listMessagesAfter(conversationId, st.lastProcessedSeq);` 之前加：

```ts
    const startSeq = st.lastProcessedSeq;
    const startAgentRounds = st.agentRounds;
```

2. 在 `const signal = st.abort.signal;` 之后加 `let finishedAny = false;`。
3. 把 speaker 循环里的

```ts
        const completed = await this.invokeAgent(current, agent, 'round', signal);
        if (!completed) break;
```

改成：

```ts
        const completed = await this.invokeAgent(current, agent, 'round', signal);
        if (!completed) break;
        finishedAny = true;
```

4. 把 `finally { this.endRun(conversationId, st); }` 改成：

```ts
    } finally {
      // Stopped or paused before anyone finished: the question is still unanswered, so hand it back.
      const interrupted = signal.aborted || this.stopped || (store.getConversation(conversationId)?.settings.paused ?? false);
      if (interrupted && !finishedAny) {
        st.lastProcessedSeq = startSeq;
        st.agentRounds = startAgentRounds;
      }
      this.endRun(conversationId, st);
    }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS（包括原有的暂停、停止相关用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/scheduler.ts packages/hub/test/scheduler-limits.test.ts
git commit -m "fix(hub): a round stopped or paused before anyone answered hands its question back for after resume" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `packages/web` 脚手架（依赖、构建、测试环境）

**Files:**
- Create: `packages/web/package.json`、`packages/web/index.html`、`packages/web/vite.config.ts`、`packages/web/tsconfig.json`、`packages/web/src/main.tsx`、`packages/web/src/App.tsx`、`packages/web/src/env.d.ts`、`packages/web/src/styles.css`、`packages/web/test/setup.ts`
- Test: `packages/web/src/App.test.tsx`
- Modify: `package.json`（scripts）、`tsconfig.json`（exclude）、`vitest.workspace.ts`（web project）、`package-lock.json`

**Interfaces:**
- Produces: `npm run build` 生成 `packages/web/dist/index.html`；`npm run web:dev` 开发服务器（5173，代理到 hub）；vitest project `web`（jsdom）；`npm run typecheck` 同时检查 web。

- [ ] **Step 1: 建包并安装依赖**

新建 `packages/web/package.json`：

```json
{
  "name": "@agent-chat/web",
  "version": "0.1.0",
  "private": true,
  "type": "module"
}
```

Run（在仓库根目录）：

```bash
npm install -w packages/web react@18.3.1 react-dom@18.3.1 react-markdown@9.1.0 rehype-highlight@7.0.2
npm install -w packages/web -D @types/react@18.3.31 @types/react-dom@18.3.7 @vitejs/plugin-react@4.7.0 vite@5.4.21 jsdom@25.0.1 @testing-library/react@16.3.3 @testing-library/dom@10.4.2 @playwright/test@1.62.1
# 如果 npm 配置的是镜像源：把 package-lock.json 里的镜像下载地址改回 https://registry.npmjs.org/
grep '"resolved"' package-lock.json | grep -vc 'https://registry.npmjs.org/'
```

Expected: 最后一条输出 `0`。

- [ ] **Step 2: 写配置文件**

`packages/web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent Chat</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/web/vite.config.ts`：

```ts
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const hub = `http://127.0.0.1:${process.env.AGENTCHAT_PORT ?? 4317}`;

export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: hub, changeOrigin: true },
      // The hub checks Origin on /ws, so present the hub's own origin through the dev proxy.
      '/ws': { target: hub.replace('http', 'ws'), ws: true, changeOrigin: true, headers: { origin: hub } },
    },
  },
});
```

`packages/web/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"]
  },
  "include": ["src", "test", "e2e"],
  "exclude": []
}
```

`packages/web/src/env.d.ts`：

```ts
declare module '*.css';
```

`packages/web/test/setup.ts`：

```ts
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());
```

`packages/web/src/styles.css`（Task 12 会写满，这里先占位一行）：

```css
body { margin: 0; }
```

`packages/web/src/App.tsx`（Task 12 会替换）：

```tsx
export function App() {
  return <h1>Agent Chat</h1>;
}
```

`packages/web/src/main.tsx`：

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

根目录 `tsconfig.json`：在 `"include"` 之后加 `"exclude": ["packages/web"]`（web 用自己的 tsconfig，DOM 类型不混进 Node 包）。

根目录 `package.json` 的 `scripts`：把 `"typecheck": "tsc --noEmit",` 改成 `"typecheck": "tsc --noEmit && tsc --noEmit -p packages/web",`，并加：

```json
    "build": "vite build --config packages/web/vite.config.ts",
    "web:dev": "vite --config packages/web/vite.config.ts",
    "e2e": "npm run build && playwright test -c packages/web/playwright.config.ts",
```

`vitest.workspace.ts` 改成：

```ts
import { defineWorkspace } from 'vitest/config';

// Every package gets the same setup file, which makes it impossible for a test to reach a real
// agent CLI, the user's global configs, the keychain or a browser (see test/guard.ts).
const setupFiles = ['test/guard.ts'];

export default defineWorkspace([
  { extends: './vitest.config.ts', test: { name: 'mcp', include: ['packages/mcp/**/*.test.ts'], setupFiles } },
  { extends: './vitest.config.ts', test: { name: 'others', include: ['packages/{adapters,hub}/**/*.test.ts'], setupFiles } },
  {
    extends: './vitest.config.ts',
    esbuild: { jsx: 'automatic' },
    test: {
      name: 'web',
      include: ['packages/web/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
      setupFiles: [...setupFiles, 'packages/web/test/setup.ts'],
    },
  },
]);
```

- [ ] **Step 3: 写一个冒烟测试**

`packages/web/src/App.test.tsx`（Task 12 会替换）：

```tsx
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { App } from './App';

it('renders', () => {
  render(<App />);
  expect(screen.getByText('Agent Chat')).toBeTruthy();
});
```

- [ ] **Step 4: 运行测试、构建和类型检查**

Run: `npm test && npm run typecheck && npm run build && ls packages/web/dist`
Expected: 测试全部 PASS（多一个 web project）；typecheck 无错误；`dist` 里有 `index.html` 和 `assets/`。`dist/` 已被 `.gitignore` 忽略。

- [ ] **Step 5: Commit**

```bash
git add packages/web package.json package-lock.json tsconfig.json vitest.workspace.ts
git status --short   # 确认没有 packages/web/dist
git commit -m "build(web): React + Vite package, build and dev scripts, jsdom test project" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 类型、token、HTTP 客户端、WebSocket 连接

**Files:**
- Create: `packages/web/src/types.ts`、`packages/web/src/token.ts`、`packages/web/src/api.ts`、`packages/web/src/ws.ts`
- Test: `packages/web/src/token.test.ts`、`packages/web/src/api.test.ts`、`packages/web/src/ws.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`：`Availability`、`Member`、`MemberView`、`Settings`、`Conversation`、`ConversationView`、`Attachment`、`Message`、`HubEvent`、`StateResponse`（见代码）。
  - `takeToken(env?: TokenEnv): string | null`、`forgetToken(env?: TokenEnv): void`、`TOKEN_KEY = 'agentchat.token'`。
  - `createApi(token: string, fetchImpl?: typeof fetch): Api`，`Api` 含 `state()`、`messages(id, beforeSeq?)`、`send(id, body)`、`createGroup(title, memberIds)`、`setPaused(id, paused)`、`stop()`、`resume()`、`refreshAvailability()`；错误类 `UnauthorizedError`、`HubDownError`、`ApiError`（`status`）。
  - `connectHub(o: HubSocketOptions): { close(): void }`、`type WsStatus = 'connecting' | 'open' | 'closed'`。

- [ ] **Step 1: 写类型**

`packages/web/src/types.ts`（与 `packages/hub/src/types.ts` 保持一致；web 不直接 import hub 的源码，免得把 Node 代码拉进前端类型检查）：

```ts
// Mirrors packages/hub/src/types.ts (keep in sync) plus the shapes the hub's HTTP API adds.
export interface Availability {
  ok: boolean;
  reason?: string;
}

export interface Member {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  bio: string;
  adapter: string | null;
}

/** A member as /api/state returns it. */
export type MemberView = Member & { availability: Availability | null };

export interface Settings {
  debounceMs: number;
  maxAgentRounds: number;
  dailyInvocationCap: number;
  timeoutMs: number;
  paused: boolean;
}

export interface Conversation {
  id: string;
  kind: 'dm' | 'group' | 'ask';
  title: string;
  settings: Settings;
  memberIds: string[];
  createdAt: number;
}

export type ConversationView = Conversation & { lastMessage: Message | null };

export interface Attachment {
  name: string;
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

export type HubEvent =
  | { type: 'message'; message: Message }
  | { type: 'typing'; conversationId: string; memberId: string; active: boolean }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'stopped'; stopped: boolean }
  | { type: 'availability'; adapter: string; availability: Availability };

export interface StateResponse {
  me: Member;
  members: MemberView[];
  conversations: ConversationView[];
  stopped: boolean;
}
```

- [ ] **Step 2: 写失败的测试**

`packages/web/src/token.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { TOKEN_KEY, forgetToken, takeToken, type TokenEnv } from './token';

function env(hash: string, stored: string | null = null) {
  const store = new Map<string, string>();
  if (stored !== null) store.set(TOKEN_KEY, stored);
  const replaced: string[] = [];
  const e: TokenEnv = {
    location: { hash, pathname: '/', search: '' },
    history: { replaceState: (_d, _u, url) => void replaced.push(String(url)) },
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
  };
  return { e, store, replaced };
}

describe('takeToken', () => {
  it('reads #token=, stores it and removes it from the address bar', () => {
    const t = env('#token=a%2Bb');
    expect(takeToken(t.e)).toBe('a+b');
    expect(t.store.get(TOKEN_KEY)).toBe('a+b');
    expect(t.replaced).toEqual(['/']);
  });

  it('falls back to the stored token without touching the address bar', () => {
    const t = env('', 'saved');
    expect(takeToken(t.e)).toBe('saved');
    expect(t.replaced).toEqual([]);
  });

  it('returns null when there is neither', () => {
    expect(takeToken(env('').e)).toBeNull();
  });

  it('forgetToken removes the stored token', () => {
    const t = env('', 'saved');
    forgetToken(t.e);
    expect(t.store.has(TOKEN_KEY)).toBe(false);
  });
});
```

`packages/web/src/api.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ApiError, HubDownError, UnauthorizedError, createApi } from './api';

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('createApi', () => {
  it('sends the bearer token and a JSON body', async () => {
    const f = fakeFetch(200, { id: 'm1' });
    await createApi('tok', f.impl).send('c 1', '你好');
    expect(f.calls[0].url).toBe('/api/conversations/c%201/messages');
    expect(f.calls[0].init.method).toBe('POST');
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect((f.calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ body: '你好' });
  });

  it('pages messages with beforeSeq', async () => {
    const f = fakeFetch(200, []);
    await createApi('tok', f.impl).messages('c1', 42);
    expect(f.calls[0].url).toBe('/api/conversations/c1/messages?limit=50&beforeSeq=42');
  });

  it('maps 401, network failure and other errors', async () => {
    await expect(createApi('tok', fakeFetch(401, { error: 'unauthorized' }).impl).state()).rejects.toBeInstanceOf(UnauthorizedError);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(createApi('tok', down).state()).rejects.toBeInstanceOf(HubDownError);
    const err = await createApi('tok', fakeFetch(400, { error: 'empty message' }).impl)
      .send('c1', ' ')
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('empty message');
  });
});
```

`packages/web/src/ws.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { HubEvent } from './types';
import { connectHub, type WsStatus } from './ws';

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.onclose?.({ code: 1000 });
  }
}

function start() {
  FakeSocket.all = [];
  const statuses: WsStatus[] = [];
  const events: HubEvent[] = [];
  const timers: Array<[() => void, number]> = [];
  let ready = 0;
  let unauthorized = 0;
  const client = connectHub({
    token: 'tok',
    url: 'ws://hub/ws',
    createSocket: (u) => new FakeSocket(u) as unknown as WebSocket,
    schedule: (fn, ms) => void timers.push([fn, ms]),
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    onReady: () => ready++,
    onUnauthorized: () => unauthorized++,
  });
  return { client, statuses, events, timers, ready: () => ready, unauthorized: () => unauthorized, socket: () => FakeSocket.all.at(-1)! };
}

describe('connectHub', () => {
  it('authenticates on open, reports ready, then forwards events', () => {
    const t = start();
    t.socket().onopen!();
    expect(JSON.parse(t.socket().sent[0])).toEqual({ type: 'auth', token: 'tok' });
    t.socket().onmessage!({ data: JSON.stringify({ type: 'ready' }) });
    expect(t.statuses).toEqual(['connecting', 'open']);
    expect(t.ready()).toBe(1);
    t.socket().onmessage!({ data: JSON.stringify({ type: 'stopped', stopped: true }) });
    expect(t.events).toEqual([{ type: 'stopped', stopped: true }]);
  });

  it('reconnects with a growing delay, reset after ready', () => {
    const t = start();
    t.socket().onclose!({ code: 1006 });
    expect(t.statuses.at(-1)).toBe('closed');
    expect(t.timers.map(([, ms]) => ms)).toEqual([1000]);
    t.timers[0][0]();
    t.socket().onclose!({ code: 1006 });
    expect(t.timers.map(([, ms]) => ms)).toEqual([1000, 2000]);
    t.timers[1][0]();
    t.socket().onmessage!({ data: JSON.stringify({ type: 'ready' }) });
    t.socket().onclose!({ code: 1006 });
    expect(t.timers.at(-1)![1]).toBe(1000);
  });

  it('stops on 4001 and reports unauthorized', () => {
    const t = start();
    t.socket().onclose!({ code: 4001 });
    expect(t.unauthorized()).toBe(1);
    expect(t.timers).toEqual([]);
  });

  it('close() stops reconnecting', () => {
    const t = start();
    t.client.close();
    expect(t.timers).toEqual([]);
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npx vitest run --project web`
Expected: FAIL，找不到 `./token`、`./api`、`./ws`。

- [ ] **Step 4: 实现**

`packages/web/src/token.ts`：

```ts
export const TOKEN_KEY = 'agentchat.token';

export interface TokenEnv {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url?: string | URL | null): void };
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
}

function browserEnv(): TokenEnv {
  return { location: window.location, history: window.history, storage: window.localStorage };
}

/** Takes the token from `#token=…` (saving it and wiping it from the address bar) or from storage. */
export function takeToken(env: TokenEnv = browserEnv()): string | null {
  const m = /(?:^#|&)token=([^&]+)/.exec(env.location.hash);
  if (m) {
    const token = decodeURIComponent(m[1]);
    try {
      env.storage.setItem(TOKEN_KEY, token);
    } catch {
      // storage may be blocked; the token still works for this page load
    }
    env.history.replaceState(null, '', env.location.pathname + env.location.search);
    return token;
  }
  try {
    return env.storage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function forgetToken(env: TokenEnv = browserEnv()): void {
  try {
    env.storage.removeItem(TOKEN_KEY);
  } catch {
    // nothing to forget
  }
}
```

`packages/web/src/api.ts`：

```ts
import type { Availability, Conversation, Message, StateResponse } from './types';

export class UnauthorizedError extends Error {}
export class HubDownError extends Error {}
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApi(token: string, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchImpl(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new HubDownError('hub 没有运行');
    }
    if (res.status === 401) throw new UnauthorizedError('访问令牌无效');
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (data as { error?: unknown } | null)?.error;
      throw new ApiError(res.status, typeof msg === 'string' ? msg : `HTTP ${res.status}`);
    }
    return data as T;
  }
  const conv = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;
  return {
    state: () => call<StateResponse>('GET', '/api/state'),
    messages: (id: string, beforeSeq?: number) =>
      call<Message[]>('GET', `${conv(id)}/messages?limit=50${beforeSeq !== undefined ? `&beforeSeq=${beforeSeq}` : ''}`),
    send: (id: string, body: string) => call<Message>('POST', `${conv(id)}/messages`, { body }),
    createGroup: (title: string, memberIds: string[]) => call<Conversation>('POST', '/api/conversations', { title, memberIds }),
    setPaused: (id: string, paused: boolean) => call<Conversation>('PATCH', `${conv(id)}/settings`, { paused }),
    stop: () => call<{ stopped: boolean }>('POST', '/api/stop'),
    resume: () => call<{ stopped: boolean }>('POST', '/api/resume'),
    refreshAvailability: () => call<Record<string, Availability>>('POST', '/api/availability/refresh'),
  };
}

export type Api = ReturnType<typeof createApi>;
```

`packages/web/src/ws.ts`：

```ts
import type { HubEvent } from './types';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface HubSocketOptions {
  token: string;
  onEvent(e: HubEvent): void;
  onStatus(s: WsStatus): void;
  /** Called after each successful auth, including reconnects: the place to re-sync. */
  onReady(): void;
  onUnauthorized(): void;
  url?: string;
  createSocket?: (url: string) => WebSocket;
  schedule?: (fn: () => void, ms: number) => void;
}

/** Keeps one authenticated connection to /ws, reconnecting after 1, 2, 4 … up to 30 seconds. */
export function connectHub(o: HubSocketOptions): { close(): void } {
  const url = o.url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const create = o.createSocket ?? ((u: string) => new WebSocket(u));
  const schedule = o.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  let attempt = 0;
  let closed = false;
  let socket: WebSocket | null = null;

  const open = () => {
    if (closed) return;
    o.onStatus('connecting');
    const s = create(url);
    socket = s;
    s.onopen = () => s.send(JSON.stringify({ type: 'auth', token: o.token }));
    s.onmessage = (ev) => {
      let e: { type?: string };
      try {
        e = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (e.type === 'ready') {
        attempt = 0;
        o.onStatus('open');
        o.onReady();
      } else {
        o.onEvent(e as HubEvent);
      }
    };
    s.onclose = (ev) => {
      socket = null;
      if (closed) return;
      if (ev.code === 4001) {
        o.onUnauthorized();
        return;
      }
      o.onStatus('closed');
      const delay = Math.min(30000, 1000 * 2 ** attempt);
      attempt++;
      schedule(open, delay);
    };
  };

  open();
  return {
    close() {
      closed = true;
      socket?.close();
    },
  };
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/types.ts packages/web/src/token.ts packages/web/src/api.ts packages/web/src/ws.ts packages/web/src/*.test.ts
git commit -m "feat(web): token from the address fragment, HTTP client and a reconnecting websocket" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 状态 store（纯函数 reducer 和选择器）

**Files:**
- Create: `packages/web/src/store.ts`
- Test: `packages/web/src/store.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `types.ts`。
- Produces: `ChatState`、`Connection = 'connecting' | 'open' | 'closed' | 'unauthorized' | 'hub_down'`、`initialState`、`Action`、`reduce(s, a)`、`mergeMessages(a, b)`、`PAGE = 50`、`sidebarGroups(s): { groups; dms; asks }`、`dmAgent(s, c): MemberView | undefined`。

- [ ] **Step 1: 写失败的测试**

`packages/web/src/store.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { PAGE, dmAgent, initialState, mergeMessages, reduce, sidebarGroups, type ChatState } from './store';
import type { Conversation, MemberView, Message, StateResponse } from './types';

const settings = { debounceMs: 3000, maxAgentRounds: 6, dailyInvocationCap: 200, timeoutMs: 300000, paused: false };
const me: MemberView = { id: 'me', kind: 'human', name: '我', bio: '', adapter: null, availability: null };
const alpha: MemberView = { id: 'a', kind: 'agent', name: 'Alpha', bio: '', adapter: 'fake-a', availability: { ok: true } };
const conv = (id: string, kind: Conversation['kind'], createdAt = 1, memberIds = ['me', 'a']): Conversation => ({
  id, kind, title: id, settings, memberIds, createdAt,
});
const msg = (id: string, conversationId: string, seq: number, senderId: string | null = 'a'): Message => ({
  id, seq, conversationId, senderId, kind: 'normal', body: id, mentions: [], replyTo: null, attachments: [], meta: null, createdAt: seq * 1000,
});
function loaded(): ChatState {
  const state: StateResponse = {
    me,
    members: [me, alpha],
    conversations: [
      { ...conv('dm1', 'dm'), lastMessage: msg('m1', 'dm1', 1) },
      { ...conv('g1', 'group', 2), lastMessage: null },
      { ...conv('ask1', 'ask', 3), lastMessage: msg('m2', 'ask1', 2) },
    ],
    stopped: false,
  };
  return reduce(initialState, { type: 'state', state });
}

describe('reduce', () => {
  it('loads state and keeps last messages apart from conversations', () => {
    const s = loaded();
    expect(s.me).toEqual(me);
    expect(s.conversations.map((c) => c.id)).toEqual(['dm1', 'g1', 'ask1']);
    expect('lastMessage' in s.conversations[0]).toBe(false);
    expect(s.lastMessage.dm1?.id).toBe('m1');
    expect(s.lastMessage.g1).toBeNull();
  });

  it('merges pages by id in seq order and tracks whether older messages remain', () => {
    let s = loaded();
    const page = Array.from({ length: PAGE }, (_, i) => msg(`p${i}`, 'dm1', 100 + i));
    s = reduce(s, { type: 'messages', conversationId: 'dm1', messages: page, older: false });
    expect(s.hasMore.dm1).toBe(true);
    s = reduce(s, { type: 'messages', conversationId: 'dm1', messages: [msg('old', 'dm1', 50), msg('p0', 'dm1', 100)], older: true });
    expect(s.messages.dm1[0].id).toBe('old');
    expect(s.messages.dm1.filter((m) => m.id === 'p0')).toHaveLength(1);
    expect(s.hasMore.dm1).toBe(false);
  });

  it('appends a message event only to a loaded conversation, without duplicates, and updates the last message', () => {
    let s = loaded();
    s = reduce(s, { type: 'event', event: { type: 'message', message: msg('m3', 'g1', 3) } });
    expect(s.messages.g1).toBeUndefined();
    expect(s.lastMessage.g1?.id).toBe('m3');
    s = reduce(s, { type: 'messages', conversationId: 'dm1', messages: [msg('m1', 'dm1', 1)], older: false });
    s = reduce(s, { type: 'event', event: { type: 'message', message: msg('m4', 'dm1', 4) } });
    s = reduce(s, { type: 'event', event: { type: 'message', message: msg('m4', 'dm1', 4) } });
    expect(s.messages.dm1.map((m) => m.id)).toEqual(['m1', 'm4']);
  });

  it('tracks typing per conversation', () => {
    let s = loaded();
    s = reduce(s, { type: 'event', event: { type: 'typing', conversationId: 'dm1', memberId: 'a', active: true } });
    s = reduce(s, { type: 'event', event: { type: 'typing', conversationId: 'dm1', memberId: 'a', active: true } });
    expect(s.typing.dm1).toEqual(['a']);
    s = reduce(s, { type: 'event', event: { type: 'typing', conversationId: 'dm1', memberId: 'a', active: false } });
    expect(s.typing.dm1).toEqual([]);
  });

  it('upserts conversations, sets stopped and updates availability', () => {
    let s = loaded();
    s = reduce(s, { type: 'event', event: { type: 'conversation', conversation: conv('g2', 'group', 9) } });
    s = reduce(s, { type: 'event', event: { type: 'conversation', conversation: { ...conv('g1', 'group', 2), title: '改名' } } });
    expect(s.conversations.map((c) => c.title)).toEqual(['dm1', '改名', 'ask1', 'g2']);
    s = reduce(s, { type: 'event', event: { type: 'stopped', stopped: true } });
    expect(s.stopped).toBe(true);
    s = reduce(s, { type: 'event', event: { type: 'availability', adapter: 'fake-a', availability: { ok: false, reason: '未登录' } } });
    expect(s.members.find((m) => m.id === 'a')?.availability).toEqual({ ok: false, reason: '未登录' });
  });

  it('records the connection status', () => {
    expect(reduce(initialState, { type: 'connection', connection: 'hub_down' }).connection).toBe('hub_down');
  });
});

describe('selectors', () => {
  it('groups the sidebar and sorts groups and asks by latest activity', () => {
    let s = loaded();
    s = reduce(s, { type: 'event', event: { type: 'conversation', conversation: conv('g2', 'group', 0) } });
    s = reduce(s, { type: 'event', event: { type: 'message', message: msg('m9', 'g2', 9) } });
    const g = sidebarGroups(s);
    expect(g.groups.map((c) => c.id)).toEqual(['g2', 'g1']);
    expect(g.dms.map((c) => c.id)).toEqual(['dm1']);
    expect(g.asks.map((c) => c.id)).toEqual(['ask1']);
  });

  it('finds the agent of a private chat', () => {
    const s = loaded();
    expect(dmAgent(s, s.conversations[0])?.name).toBe('Alpha');
  });

  it('mergeMessages keeps the incoming copy of a duplicate', () => {
    const a = msg('x', 'c', 1);
    expect(mergeMessages([a], [{ ...a, body: 'new' }])[0].body).toBe('new');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run --project web packages/web/src/store.test.ts`
Expected: FAIL，找不到 `./store`。

- [ ] **Step 3: 实现**

`packages/web/src/store.ts`：

```ts
import type { Conversation, HubEvent, Member, MemberView, Message, StateResponse } from './types';

export type Connection = 'connecting' | 'open' | 'closed' | 'unauthorized' | 'hub_down';
export const PAGE = 50;

export interface ChatState {
  me: Member | null;
  members: MemberView[];
  conversations: Conversation[];
  lastMessage: Record<string, Message | null>;
  /** Messages loaded so far per conversation, ascending by seq; absent until the conversation is opened. */
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  typing: Record<string, string[]>;
  stopped: boolean;
  connection: Connection;
}

export const initialState: ChatState = {
  me: null,
  members: [],
  conversations: [],
  lastMessage: {},
  messages: {},
  hasMore: {},
  typing: {},
  stopped: false,
  connection: 'connecting',
};

export type Action =
  | { type: 'state'; state: StateResponse }
  | { type: 'messages'; conversationId: string; messages: Message[]; older: boolean }
  | { type: 'event'; event: HubEvent }
  | { type: 'connection'; connection: Connection };

export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

const newer = (a: Message | null | undefined, b: Message): Message => (!a || b.seq > a.seq ? b : a);

export function reduce(s: ChatState, a: Action): ChatState {
  switch (a.type) {
    case 'state': {
      const lastMessage: Record<string, Message | null> = {};
      for (const c of a.state.conversations) {
        const prev = s.lastMessage[c.id] ?? null;
        lastMessage[c.id] = c.lastMessage ? newer(prev, c.lastMessage) : prev;
      }
      const conversations = a.state.conversations.map(({ lastMessage: _drop, ...c }) => c);
      return { ...s, me: a.state.me, members: a.state.members, conversations, lastMessage, stopped: a.state.stopped };
    }
    case 'messages': {
      const id = a.conversationId;
      const merged = mergeMessages(s.messages[id] ?? [], a.messages);
      const hasMore = a.older || !(id in s.hasMore) ? a.messages.length >= PAGE : s.hasMore[id];
      const last = merged.at(-1);
      return {
        ...s,
        messages: { ...s.messages, [id]: merged },
        hasMore: { ...s.hasMore, [id]: hasMore },
        lastMessage: last ? { ...s.lastMessage, [id]: newer(s.lastMessage[id], last) } : s.lastMessage,
      };
    }
    case 'connection':
      return { ...s, connection: a.connection };
    case 'event':
      return applyEvent(s, a.event);
  }
}

function applyEvent(s: ChatState, e: HubEvent): ChatState {
  switch (e.type) {
    case 'message': {
      const id = e.message.conversationId;
      const loaded = s.messages[id];
      return {
        ...s,
        messages: loaded ? { ...s.messages, [id]: mergeMessages(loaded, [e.message]) } : s.messages,
        lastMessage: { ...s.lastMessage, [id]: newer(s.lastMessage[id], e.message) },
      };
    }
    case 'typing': {
      const cur = s.typing[e.conversationId] ?? [];
      const next = e.active ? (cur.includes(e.memberId) ? cur : [...cur, e.memberId]) : cur.filter((m) => m !== e.memberId);
      return { ...s, typing: { ...s.typing, [e.conversationId]: next } };
    }
    case 'conversation': {
      const exists = s.conversations.some((c) => c.id === e.conversation.id);
      const conversations = exists
        ? s.conversations.map((c) => (c.id === e.conversation.id ? e.conversation : c))
        : [...s.conversations, e.conversation];
      return { ...s, conversations };
    }
    case 'stopped':
      return { ...s, stopped: e.stopped };
    case 'availability':
      return { ...s, members: s.members.map((m) => (m.adapter === e.adapter ? { ...m, availability: e.availability } : m)) };
  }
}

const activity = (s: ChatState, c: Conversation) => s.lastMessage[c.id]?.createdAt ?? c.createdAt;

export function sidebarGroups(s: ChatState): { groups: Conversation[]; dms: Conversation[]; asks: Conversation[] } {
  const of = (kind: Conversation['kind']) => s.conversations.filter((c) => c.kind === kind);
  const recent = (list: Conversation[]) => [...list].sort((x, y) => activity(s, y) - activity(s, x));
  return { groups: recent(of('group')), dms: of('dm'), asks: recent(of('ask')) };
}

export function dmAgent(s: ChatState, c: Conversation): MemberView | undefined {
  return s.members.find((m) => m.kind === 'agent' && c.memberIds.includes(m.id));
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/store.ts packages/web/src/store.test.ts
git commit -m "feat(web): chat state reducer, message merging and sidebar selectors" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Markdown 渲染与安全

**Files:**
- Create: `packages/web/src/components/Markdown.tsx`
- Test: `packages/web/src/components/Markdown.test.tsx`

**Interfaces:**
- Produces: `Markdown({ text }: { text: string }): JSX.Element`。

- [ ] **Step 1: 写失败的测试**

`packages/web/src/components/Markdown.test.tsx`：

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('renders formatting and highlighted code blocks', () => {
    const { container } = render(<Markdown text={'**粗体**\n\n```ts\nconst a = 1;\n```'} />);
    expect(container.querySelector('strong')?.textContent).toBe('粗体');
    const code = container.querySelector('pre code');
    expect(code?.className).toContain('hljs');
    expect(code?.textContent).toContain('const a = 1;');
  });

  it('drops raw HTML instead of running it', () => {
    const { container } = render(<Markdown text={'<script>window.x=1</script><b>粗</b><img src=x onerror="alert(1)">'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('opens http links safely and never renders javascript: links', () => {
    const { container } = render(<Markdown text={'[好](https://example.com) [坏](javascript:alert(1))'} />);
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://example.com');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toContain('坏');
  });

  it('shows images as text, so an answer cannot make the browser load a remote image', () => {
    const { container } = render(<Markdown text={'![图](https://example.com/a.png)'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('[图片：图]');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run --project web packages/web/src/components/Markdown.test.tsx`
Expected: FAIL，找不到 `./Markdown`。

- [ ] **Step 3: 实现**

`packages/web/src/components/Markdown.tsx`：

```tsx
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';

const SAFE_URL = /^(https?:|mailto:)/i;

/**
 * Agent answers are untrusted: raw HTML is dropped, only http(s)/mailto links survive and open in a
 * new tab, and images become text (no remote loads). Otherwise an answer could run script and read
 * the token in localStorage.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        rehypePlugins={[rehypeHighlight]}
        urlTransform={(url) => (SAFE_URL.test(url) ? url : '')}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt, src }) => <span>[图片：{alt || src}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/Markdown.tsx packages/web/src/components/Markdown.test.tsx
git commit -m "feat(web): safe Markdown rendering with highlighted code blocks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 头像、侧栏、新建群聊弹窗

**Files:**
- Create: `packages/web/src/components/Avatar.tsx`、`packages/web/src/components/Sidebar.tsx`、`packages/web/src/components/NewGroupDialog.tsx`
- Test: `packages/web/src/components/Sidebar.test.tsx`、`packages/web/src/components/NewGroupDialog.test.tsx`

**Interfaces:**
- Consumes: Task 8 的 `ChatState`、`sidebarGroups`、`dmAgent`、`Connection`。
- Produces: `Avatar({ name, dot? }: { name: string; dot?: 'on' | 'off' })`、`colorFor(name: string): string`；`Sidebar({ state, activeId, onSelect, onNewGroup, onRefresh })`（每个会话条目是 `aria-label={会话标题}` 的 button）、`CONNECTION_TEXT: Record<Connection, string>`；`NewGroupDialog({ agents, onCreate, onClose })`。

- [ ] **Step 1: 写失败的测试**

`packages/web/src/components/Sidebar.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { initialState, reduce } from '../store';
import type { StateResponse } from '../types';
import { Sidebar } from './Sidebar';

const settings = { debounceMs: 3000, maxAgentRounds: 6, dailyInvocationCap: 200, timeoutMs: 300000, paused: false };
const state: StateResponse = {
  me: { id: 'me', kind: 'human', name: '我', bio: '', adapter: null },
  members: [
    { id: 'me', kind: 'human', name: '我', bio: '', adapter: null, availability: null },
    { id: 'a', kind: 'agent', name: 'Alpha', bio: '', adapter: 'fake-a', availability: { ok: true } },
    { id: 'c', kind: 'agent', name: 'Claude Code', bio: '', adapter: 'claude', availability: { ok: false, reason: '未登录' } },
  ],
  conversations: [
    { id: 'dm-a', kind: 'dm', title: 'Alpha', settings, memberIds: ['me', 'a'], createdAt: 1, lastMessage: null },
    { id: 'dm-c', kind: 'dm', title: 'Claude Code', settings, memberIds: ['me', 'c'], createdAt: 2, lastMessage: null },
    {
      id: 'g', kind: 'group', title: '讨论组', settings, memberIds: ['me', 'a'], createdAt: 3,
      lastMessage: { id: 'm', seq: 1, conversationId: 'g', senderId: 'a', kind: 'normal', body: '同意', mentions: [], replyTo: null, attachments: [], meta: null, createdAt: 5 },
    },
    { id: 'q', kind: 'ask', title: 'Alpha → Claude Code', settings, memberIds: ['a', 'c'], createdAt: 4, lastMessage: null },
  ],
  stopped: false,
};

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    state: { ...reduce(initialState, { type: 'state', state }), connection: 'open' as const },
    activeId: 'g',
    onSelect: vi.fn(),
    onNewGroup: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
  render(<Sidebar {...props} />);
  return props;
}

describe('Sidebar', () => {
  it('lists groups, private chats and asks under their headings, with the last message', () => {
    renderSidebar();
    expect(screen.getByText('群聊')).toBeTruthy();
    expect(screen.getByText('私聊')).toBeTruthy();
    expect(screen.getByText('agent 互问')).toBeTruthy();
    expect(screen.getByRole('button', { name: '讨论组' }).textContent).toContain('Alpha：同意');
    expect(screen.getByRole('button', { name: '讨论组' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Alpha → Claude Code' })).toBeTruthy();
  });

  it('shows why an agent is unavailable', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Claude Code' }).textContent).toContain('未登录');
  });

  it('selects a conversation, opens the new-group dialog and refreshes availability', () => {
    const p = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(p.onSelect).toHaveBeenCalledWith('dm-a');
    fireEvent.click(screen.getByRole('button', { name: '＋ 群聊' }));
    expect(p.onNewGroup).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新检查可用状态' }));
    expect(p.onRefresh).toHaveBeenCalled();
    expect(screen.getByText('已连接 hub')).toBeTruthy();
  });
});
```

`packages/web/src/components/NewGroupDialog.test.tsx`：

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MemberView } from '../types';
import { NewGroupDialog } from './NewGroupDialog';

const agents: MemberView[] = [
  { id: 'a', kind: 'agent', name: 'Alpha', bio: '', adapter: 'fake-a', availability: { ok: true } },
  { id: 'b', kind: 'agent', name: 'Beta', bio: '', adapter: 'fake-b', availability: { ok: false, reason: '未登录' } },
];

describe('NewGroupDialog', () => {
  it('requires a title and at least one agent', async () => {
    const onCreate = vi.fn();
    render(<NewGroupDialog agents={agents} onCreate={onCreate} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByRole('alert').textContent).toBe('请填写群名');
    fireEvent.change(screen.getByLabelText('群名'), { target: { value: '讨论组' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByRole('alert').textContent).toBe('至少选一个 agent');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('creates with the chosen agents and shows a failure in place', async () => {
    const onCreate = vi.fn().mockRejectedValueOnce(new Error('title and memberIds are required')).mockResolvedValueOnce(undefined);
    render(<NewGroupDialog agents={agents} onCreate={onCreate} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('群名'), { target: { value: '讨论组' } });
    fireEvent.click(screen.getByLabelText('Alpha'));
    expect(screen.getByLabelText('Beta（未登录）')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('title and memberIds are required'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    expect(onCreate).toHaveBeenLastCalledWith('讨论组', ['a']);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run --project web packages/web/src/components`
Expected: FAIL，找不到 `./Sidebar`、`./NewGroupDialog`。

- [ ] **Step 3: 实现**

`packages/web/src/components/Avatar.tsx`：

```tsx
const COLORS = ['#af52de', '#34c759', '#32ade6', '#ff9500', '#5856d6', '#ff2d55', '#a2845e'];

export function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function Avatar({ name, dot }: { name: string; dot?: 'on' | 'off' }) {
  return (
    <span className="avatar" style={{ background: colorFor(name) }} aria-hidden="true">
      {[...name][0] ?? '?'}
      {dot && <i className={`dot dot-${dot}`} />}
    </span>
  );
}
```

`packages/web/src/components/Sidebar.tsx`：

```tsx
import { dmAgent, sidebarGroups, type ChatState, type Connection } from '../store';
import type { Conversation } from '../types';
import { Avatar } from './Avatar';

export const CONNECTION_TEXT: Record<Connection, string> = {
  connecting: '正在连接…',
  open: '已连接 hub',
  closed: '连接中断，正在重连…',
  hub_down: 'hub 没有运行',
  unauthorized: '访问令牌无效',
};

interface Props {
  state: ChatState;
  activeId: string | null;
  onSelect(id: string): void;
  onNewGroup(): void;
  onRefresh(): void;
}

export function Sidebar({ state, activeId, onSelect, onNewGroup, onRefresh }: Props) {
  const { groups, dms, asks } = sidebarGroups(state);
  const item = (c: Conversation) => <Item key={c.id} c={c} state={state} active={c.id === activeId} onSelect={onSelect} />;
  return (
    <nav className="sidebar">
      <div className="sidebar-top">
        <b>Agent Chat</b>
        <button className="new-group" onClick={onNewGroup}>
          ＋ 群聊
        </button>
      </div>
      <div className="sidebar-list">
        <div className="sidebar-heading">群聊</div>
        {groups.length ? groups.map(item) : <div className="sidebar-empty">还没有群聊</div>}
        <div className="sidebar-heading">私聊</div>
        {dms.map(item)}
        <div className="sidebar-heading">agent 互问</div>
        {asks.length ? asks.map(item) : <div className="sidebar-empty">还没有 agent 之间的提问</div>}
      </div>
      <div className="sidebar-foot">
        <span>{CONNECTION_TEXT[state.connection]}</span>
        <button className="link" onClick={onRefresh}>
          重新检查可用状态
        </button>
      </div>
    </nav>
  );
}

function Item({ c, state, active, onSelect }: { c: Conversation; state: ChatState; active: boolean; onSelect(id: string): void }) {
  const agent = c.kind === 'dm' ? dmAgent(state, c) : undefined;
  const unavailable = agent?.availability && !agent.availability.ok ? (agent.availability.reason ?? '不可用') : null;
  const last = state.lastMessage[c.id];
  const sender = last?.senderId ? state.members.find((m) => m.id === last.senderId)?.name : undefined;
  const summary = last ? `${last.kind === 'system' ? '系统' : (sender ?? '未知')}：${last.body}` : '';
  return (
    <button
      className={`conv${active ? ' conv-active' : ''}${unavailable ? ' conv-off' : ''}`}
      aria-label={c.title}
      aria-current={active ? 'true' : undefined}
      onClick={() => onSelect(c.id)}
    >
      <Avatar name={c.kind === 'ask' ? '⇄' : c.title} dot={agent ? (unavailable ? 'off' : 'on') : undefined} />
      <span className="conv-text">
        <span className="conv-title">
          {c.title}
          {unavailable && <span className="conv-reason">{unavailable}</span>}
        </span>
        {c.kind !== 'dm' && summary && <span className="conv-summary">{summary}</span>}
      </span>
    </button>
  );
}
```

`packages/web/src/components/NewGroupDialog.tsx`：

```tsx
import { useState, type FormEvent } from 'react';
import type { MemberView } from '../types';

interface Props {
  agents: MemberView[];
  onCreate(title: string, memberIds: string[]): Promise<void>;
  onClose(): void;
}

export function NewGroupDialog({ agents, onCreate, onClose }: Props) {
  const [title, setTitle] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError('请填写群名');
    if (ids.length === 0) return setError('至少选一个 agent');
    setBusy(true);
    setError(null);
    try {
      await onCreate(title.trim(), ids);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label="新建群聊" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>新建群聊</h3>
        <label className="field">
          群名
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
        <fieldset className="field">
          <legend>成员</legend>
          {agents.map((a) => (
            <label key={a.id} className="check">
              <input type="checkbox" checked={ids.includes(a.id)} onChange={() => toggle(a.id)} />
              {a.name}
              {a.availability && !a.availability.ok ? `（${a.availability.reason ?? '不可用'}）` : ''}
            </label>
          ))}
        </fieldset>
        {error && (
          <div role="alert" className="dialog-error">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy}>
            创建
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/Avatar.tsx packages/web/src/components/Sidebar.tsx packages/web/src/components/NewGroupDialog.tsx packages/web/src/components/Sidebar.test.tsx packages/web/src/components/NewGroupDialog.test.tsx
git commit -m "feat(web): sidebar with grouped conversations and availability, new-group dialog" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 会话区：头部、消息列表、输入框与 @ 补全

**Files:**
- Create: `packages/web/src/mentions.ts`、`packages/web/src/components/ChatHeader.tsx`、`packages/web/src/components/MessageItem.tsx`、`packages/web/src/components/MessageList.tsx`、`packages/web/src/components/Composer.tsx`
- Test: `packages/web/src/mentions.test.ts`、`packages/web/src/components/ChatHeader.test.tsx`、`packages/web/src/components/MessageList.test.tsx`、`packages/web/src/components/Composer.test.tsx`

**Interfaces:**
- Consumes: Task 9 的 `Markdown`、Task 10 的 `Avatar`。
- Produces: `mentionQuery(text, caret): { start: number; query: string } | null`、`filterMembers<T extends { name: string }>(members: T[], query: string): T[]`、`applyMention(text, start, caret, name): { text: string; caret: number }`；`ChatHeader({ conversation, memberNames, stopped, onTogglePause, onStop, onResume })`；`MessageItem({ message, sender, mine })`；`MessageList({ messages, members, meId, typingIds, hasMore, onLoadOlder })`（正在输入的元素带 `aria-label="<名字> 正在输入"`）；`Composer({ candidates, onSend, placeholder? })`（textarea 的 `aria-label="消息"`）。

- [ ] **Step 1: 写失败的测试**

`packages/web/src/mentions.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { applyMention, filterMembers, mentionQuery } from './mentions';

describe('mentions', () => {
  it('finds the @word at the caret', () => {
    expect(mentionQuery('你好 @Op', 6)).toEqual({ start: 3, query: 'Op' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('a@b', 3)).toBeNull();
    expect(mentionQuery('@Alpha 你好', 9)).toBeNull();
  });

  it('filters by name, prefix matches first, case-insensitive', () => {
    const ms = [{ name: 'OpenCode' }, { name: 'Claude Code' }, { name: 'Codex' }];
    expect(filterMembers(ms, 'co').map((m) => m.name)).toEqual(['Codex', 'OpenCode', 'Claude Code']);
  });

  it('replaces the @word with the full name and a space', () => {
    expect(applyMention('看 @Op 呢', 2, 5, 'OpenCode')).toEqual({ text: '看 @OpenCode  呢', caret: 12 });
  });
});
```

`packages/web/src/components/ChatHeader.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../types';
import { ChatHeader } from './ChatHeader';

const settings = { debounceMs: 3000, maxAgentRounds: 6, dailyInvocationCap: 200, timeoutMs: 300000, paused: false };
const group: Conversation = { id: 'g', kind: 'group', title: '讨论组', settings, memberIds: [], createdAt: 1 };

describe('ChatHeader', () => {
  it('shows the pause switch only for groups, and stop or resume', () => {
    const on = { onTogglePause: vi.fn(), onStop: vi.fn(), onResume: vi.fn() };
    const { rerender } = render(<ChatHeader conversation={group} memberNames={['我', 'Alpha']} stopped={false} {...on} />);
    expect(screen.getByRole('heading', { name: '讨论组' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '⏸ 暂停本群' }));
    expect(on.onTogglePause).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '■ 全部停止' }));
    expect(on.onStop).toHaveBeenCalled();

    rerender(<ChatHeader conversation={{ ...group, settings: { ...settings, paused: true } }} memberNames={[]} stopped {...on} />);
    expect(screen.getByRole('button', { name: '▶ 恢复本群' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '▶ 恢复' }));
    expect(on.onResume).toHaveBeenCalled();

    rerender(<ChatHeader conversation={{ ...group, kind: 'dm' }} memberNames={[]} stopped={false} {...on} />);
    expect(screen.queryByRole('button', { name: '⏸ 暂停本群' })).toBeNull();
  });

  it('still offers stop with no conversation open', () => {
    render(<ChatHeader conversation={null} memberNames={[]} stopped={false} onTogglePause={() => {}} onStop={() => {}} onResume={() => {}} />);
    expect(screen.getByRole('button', { name: '■ 全部停止' })).toBeTruthy();
  });
});
```

`packages/web/src/components/MessageList.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MemberView, Message } from '../types';
import { MessageList } from './MessageList';

const members: MemberView[] = [
  { id: 'me', kind: 'human', name: '我', bio: '', adapter: null, availability: null },
  { id: 'a', kind: 'agent', name: 'Alpha', bio: '', adapter: 'fake-a', availability: { ok: true } },
];
const m = (id: string, senderId: string | null, body: string, kind: Message['kind'] = 'normal'): Message => ({
  id, seq: Number(id.slice(1)), conversationId: 'c', senderId, kind, body, mentions: [], replyTo: null, attachments: [], meta: null, createdAt: 0,
});

describe('MessageList', () => {
  it('puts my messages right as plain text, agent messages left as Markdown, system messages centered', () => {
    const { container } = render(
      <MessageList
        messages={[m('m1', 'me', '**原样**'), m('m2', 'a', '**粗体**'), m('m3', null, 'Alpha 没有回应（超时）。', 'system')]}
        members={members}
        meId="me"
        typingIds={['a']}
        hasMore={false}
        onLoadOlder={async () => {}}
      />,
    );
    expect(container.querySelector('.msg-mine .bubble')?.textContent).toBe('**原样**');
    expect(container.querySelector('.msg-agent strong')?.textContent).toBe('粗体');
    expect(screen.getByRole('note').textContent).toBe('Alpha 没有回应（超时）。');
    expect(screen.getByLabelText('Alpha 正在输入')).toBeTruthy();
  });

  it('says when older messages can be loaded', () => {
    render(<MessageList messages={[]} members={members} meId="me" typingIds={[]} hasMore onLoadOlder={async () => {}} />);
    expect(screen.getByText('向上滚动加载更早的消息')).toBeTruthy();
  });
});
```

`packages/web/src/components/Composer.test.tsx`：

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MemberView } from '../types';
import { Composer } from './Composer';

const candidates: MemberView[] = [
  { id: 'a', kind: 'agent', name: 'Alpha', bio: '', adapter: 'fake-a', availability: { ok: true } },
  { id: 'b', kind: 'agent', name: 'Beta', bio: '', adapter: 'fake-b', availability: { ok: false, reason: '未登录' } },
];
const box = () => screen.getByLabelText('消息') as HTMLTextAreaElement;

describe('Composer', () => {
  it('sends on Enter, keeps Shift+Enter for a new line, and clears after sending', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer candidates={[]} onSend={onSend} />);
    fireEvent.change(box(), { target: { value: '你好' } });
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('你好'));
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('completes an @mention with Enter, then sends with the next Enter', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer candidates={candidates} onSend={onSend} />);
    fireEvent.change(box(), { target: { value: '看看 @Be' } });
    expect(screen.getByRole('option', { name: '@Beta（未登录）' })).toBeTruthy();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('看看 @Beta ');
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('看看 @Beta'));
  });

  it('keeps the text and shows the reason when sending fails', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('empty message'));
    render(<Composer candidates={[]} onSend={onSend} />);
    fireEvent.change(box(), { target: { value: '你好' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('发送失败：empty message'));
    expect(box().value).toBe('你好');
  });

  it('does not send while an input method is composing', () => {
    const onSend = vi.fn();
    render(<Composer candidates={[]} onSend={onSend} />);
    fireEvent.change(box(), { target: { value: 'ni' } });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run --project web`
Expected: FAIL，找不到 `./mentions`、`./ChatHeader`、`./MessageList`、`./Composer`。

- [ ] **Step 3: 实现**

`packages/web/src/mentions.ts`：

```ts
export interface MentionQuery {
  /** Index of the '@'. */
  start: number;
  query: string;
}

/** The `@word` the caret sits at the end of, if any. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

export function filterMembers<T extends { name: string }>(members: T[], query: string): T[] {
  const q = query.toLowerCase();
  const hits = members.filter((m) => m.name.toLowerCase().includes(q));
  const starts = hits.filter((m) => m.name.toLowerCase().startsWith(q));
  return [...starts, ...hits.filter((m) => !starts.includes(m))];
}

export function applyMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `;
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}
```

`packages/web/src/components/ChatHeader.tsx`：

```tsx
import type { Conversation } from '../types';

interface Props {
  conversation: Conversation | null;
  memberNames: string[];
  stopped: boolean;
  onTogglePause(): void;
  onStop(): void;
  onResume(): void;
}

export function ChatHeader({ conversation, memberNames, stopped, onTogglePause, onStop, onResume }: Props) {
  const paused = conversation?.settings.paused ?? false;
  return (
    <header className="chat-header">
      <div className="chat-title">
        <h2>{conversation?.title ?? 'Agent Chat'}</h2>
        {memberNames.length > 0 && <span className="chat-members">{memberNames.join('、')}</span>}
      </div>
      <div className="chat-actions">
        {conversation?.kind === 'group' && (
          <button className={`pill${paused ? ' pill-on' : ''}`} aria-pressed={paused} onClick={onTogglePause}>
            {paused ? '▶ 恢复本群' : '⏸ 暂停本群'}
          </button>
        )}
        {stopped ? (
          <button className="pill pill-resume" onClick={onResume}>
            ▶ 恢复
          </button>
        ) : (
          <button className="pill pill-stop" onClick={onStop}>
            ■ 全部停止
          </button>
        )}
      </div>
    </header>
  );
}
```

`packages/web/src/components/MessageItem.tsx`：

```tsx
import type { MemberView, Message } from '../types';
import { Avatar } from './Avatar';
import { Markdown } from './Markdown';

export function MessageItem({ message, sender, mine }: { message: Message; sender: MemberView | undefined; mine: boolean }) {
  if (message.kind === 'system') {
    return (
      <div className="msg-system" role="note">
        {message.body}
      </div>
    );
  }
  if (mine) {
    return (
      <div className="msg msg-mine">
        <div className="bubble bubble-mine">{message.body}</div>
      </div>
    );
  }
  const name = sender?.name ?? '未知';
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="msg msg-agent">
      <Avatar name={name} />
      <div className="msg-col">
        <div className="msg-meta">
          {name} · {time}
        </div>
        <div className="bubble bubble-agent">
          <Markdown text={message.body} />
        </div>
      </div>
    </div>
  );
}
```

`packages/web/src/components/MessageList.tsx`：

```tsx
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MemberView, Message } from '../types';
import { Avatar } from './Avatar';
import { MessageItem } from './MessageItem';

interface Props {
  messages: Message[];
  members: MemberView[];
  meId: string | null;
  typingIds: string[];
  hasMore: boolean;
  onLoadOlder(): Promise<void>;
}

export function MessageList({ messages, members, meId, typingIds, hasMore, onLoadOlder }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const restore = useRef<{ height: number; top: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (restore.current) {
      // Older messages were prepended: keep what the reader was looking at in place.
      el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top;
      restore.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, typingIds.length]);

  const onScroll = async () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 40 && hasMore && !loading) {
      setLoading(true);
      restore.current = { height: el.scrollHeight, top: el.scrollTop };
      try {
        await onLoadOlder();
      } catch {
        restore.current = null;
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="messages" ref={ref} onScroll={() => void onScroll()}>
      {hasMore && <div className="load-more">{loading ? '加载中…' : '向上滚动加载更早的消息'}</div>}
      {messages.map((m) => (
        <MessageItem key={m.id} message={m} sender={m.senderId ? byId.get(m.senderId) : undefined} mine={m.senderId !== null && m.senderId === meId} />
      ))}
      {typingIds.map((id) => {
        const name = byId.get(id)?.name ?? '?';
        return (
          <div key={id} className="msg msg-agent" aria-label={`${name} 正在输入`}>
            <Avatar name={name} />
            <div className="bubble bubble-typing">●●●</div>
          </div>
        );
      })}
    </div>
  );
}
```

`packages/web/src/components/Composer.tsx`：

```tsx
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { applyMention, filterMembers, mentionQuery } from '../mentions';
import type { MemberView } from '../types';

interface Props {
  /** Members that can be @-mentioned here (empty: no completion). */
  candidates: MemberView[];
  onSend(body: string): Promise<void>;
  placeholder?: string;
}

export function Composer({ candidates, onSend, placeholder = '发消息，@ 提到成员' }: Props) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  const q = mentionQuery(text, caret);
  const options = q && q.start !== dismissed ? filterMembers(candidates, q.query) : [];

  useEffect(() => setSelected(0), [q?.query]);
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && ref.current) {
      ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      ref.current.focus();
      pendingCaret.current = null;
    }
  });

  const pick = (m: MemberView) => {
    if (!q) return;
    const r = applyMention(text, q.start, caret, m.name);
    setText(r.text);
    setCaret(r.caret);
    pendingCaret.current = r.caret;
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(body);
      setText('');
      setCaret(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (options.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setSelected((selected + step + options.length) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(options[Math.min(selected, options.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        setDismissed(q?.start ?? null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="composer">
      {options.length > 0 && (
        <ul className="mention-list" role="listbox">
          {options.map((m, i) => {
            const off = m.availability && !m.availability.ok;
            return (
              <li
                key={m.id}
                role="option"
                aria-selected={i === selected}
                className={`${i === selected ? 'selected' : ''}${off ? ' off' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m);
                }}
              >
                @{m.name}
                {off ? `（${m.availability?.reason ?? '不可用'}）` : ''}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <div className="composer-error" role="alert">
          发送失败：{error}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={ref}
          aria-label="消息"
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissed(null);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
        />
        <button className="send" aria-label="发送" disabled={sending || !text.trim()} onClick={() => void send()}>
          ↑
        </button>
      </div>
      <div className="composer-hint">Enter 发送 · Shift+Enter 换行</div>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/mentions.ts packages/web/src/mentions.test.ts packages/web/src/components/ChatHeader.tsx packages/web/src/components/ChatHeader.test.tsx packages/web/src/components/MessageItem.tsx packages/web/src/components/MessageList.tsx packages/web/src/components/MessageList.test.tsx packages/web/src/components/Composer.tsx packages/web/src/components/Composer.test.tsx
git commit -m "feat(web): chat header, bubble message list with typing, composer with @ completion" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: `useChat`、App 组装、样式

**Files:**
- Create: `packages/web/src/useChat.ts`
- Modify: `packages/web/src/App.tsx`（替换占位）、`packages/web/src/styles.css`（写满）
- Test: `packages/web/src/App.test.tsx`（替换）

**Interfaces:**
- Consumes: Task 7 的 `createApi`、错误类、`connectHub`、`takeToken`、`forgetToken`；Task 8 的 store；Task 10、11 的组件。
- Produces: `useChat(token: string)` 返回 `{ state, activeId, select(id), loadOlder(), send(body), createGroup(title, ids), togglePause(), stop(), resume(), refreshAvailability() }`；`App`。

- [ ] **Step 1: 写失败的测试**

把 `packages/web/src/App.test.tsx` 整个替换为：

```tsx
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { App } from './App';
import { TOKEN_KEY } from './token';

afterEach(() => window.localStorage.removeItem(TOKEN_KEY));

it('asks for the address printed by npm run hub when there is no token', () => {
  render(<App />);
  expect(screen.getByText(/npm run hub/)).toBeTruthy();
});
```

（`useChat` 的逻辑由 Task 7、8 的单元测试和 Task 13 的端到端测试覆盖。）

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run --project web packages/web/src/App.test.tsx`
Expected: FAIL（占位 App 里没有 "npm run hub"）。

- [ ] **Step 3: 实现**

`packages/web/src/useChat.ts`：

```ts
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { HubDownError, UnauthorizedError, createApi } from './api';
import { initialState, reduce } from './store';
import { forgetToken } from './token';
import { connectHub } from './ws';

export function useChat(token: string) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const api = useMemo(() => createApi(token), [token]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;
  const stateRef = useRef(state);
  stateRef.current = state;

  /** Handles errors every action shares; returns true when it did. */
  const handled = useCallback((e: unknown): boolean => {
    if (e instanceof UnauthorizedError) {
      forgetToken();
      dispatch({ type: 'connection', connection: 'unauthorized' });
      return true;
    }
    if (e instanceof HubDownError) {
      dispatch({ type: 'connection', connection: 'hub_down' });
      return true;
    }
    return false;
  }, []);

  const loadLatest = useCallback(
    async (id: string) => {
      const messages = await api.messages(id);
      dispatch({ type: 'messages', conversationId: id, messages, older: false });
    },
    [api],
  );

  // After every (re)connect: reload state and the open conversation so nothing missed stays missing.
  const resync = useCallback(async () => {
    try {
      dispatch({ type: 'state', state: await api.state() });
      const id = activeRef.current;
      if (id) await loadLatest(id);
    } catch (e) {
      handled(e);
    }
  }, [api, loadLatest, handled]);

  useEffect(() => {
    const conn = connectHub({
      token,
      onEvent: (event) => dispatch({ type: 'event', event }),
      onStatus: (s) => dispatch({ type: 'connection', connection: s }),
      onReady: () => void resync(),
      onUnauthorized: () => {
        forgetToken();
        dispatch({ type: 'connection', connection: 'unauthorized' });
      },
    });
    return () => conn.close();
  }, [token, resync]);

  const select = useCallback(
    (id: string) => {
      setActiveId(id);
      loadLatest(id).catch(handled);
    },
    [loadLatest, handled],
  );

  const loadOlder = useCallback(async () => {
    const id = activeRef.current;
    const first = id ? stateRef.current.messages[id]?.[0] : undefined;
    if (!id || !first) return;
    try {
      dispatch({ type: 'messages', conversationId: id, messages: await api.messages(id, first.seq), older: true });
    } catch (e) {
      if (!handled(e)) throw e;
    }
  }, [api, handled]);

  /** Errors reach the caller (the composer shows them); the message itself arrives over the websocket. */
  const send = useCallback(
    async (body: string) => {
      const id = activeRef.current;
      if (!id) return;
      try {
        await api.send(id, body);
      } catch (e) {
        handled(e);
        throw e;
      }
    },
    [api, handled],
  );

  const createGroup = useCallback(
    async (title: string, memberIds: string[]) => {
      try {
        const conversation = await api.createGroup(title, memberIds);
        dispatch({ type: 'event', event: { type: 'conversation', conversation } });
        select(conversation.id);
      } catch (e) {
        handled(e);
        throw e;
      }
    },
    [api, select, handled],
  );

  const togglePause = useCallback(async () => {
    const conv = stateRef.current.conversations.find((c) => c.id === activeRef.current);
    if (!conv) return;
    try {
      const conversation = await api.setPaused(conv.id, !conv.settings.paused);
      dispatch({ type: 'event', event: { type: 'conversation', conversation } });
    } catch (e) {
      handled(e);
    }
  }, [api, handled]);

  const setStopped = useCallback(
    async (stop: boolean) => {
      try {
        const r = stop ? await api.stop() : await api.resume();
        dispatch({ type: 'event', event: { type: 'stopped', stopped: r.stopped } });
      } catch (e) {
        handled(e);
      }
    },
    [api, handled],
  );

  const refreshAvailability = useCallback(async () => {
    try {
      const all = await api.refreshAvailability();
      for (const [adapter, availability] of Object.entries(all)) {
        dispatch({ type: 'event', event: { type: 'availability', adapter, availability } });
      }
    } catch (e) {
      handled(e);
    }
  }, [api, handled]);

  return {
    state,
    activeId,
    select,
    loadOlder,
    send,
    createGroup,
    togglePause,
    stop: () => setStopped(true),
    resume: () => setStopped(false),
    refreshAvailability,
  };
}
```

把 `packages/web/src/App.tsx` 整个替换为：

```tsx
import { useState } from 'react';
import { ChatHeader } from './components/ChatHeader';
import { Composer } from './components/Composer';
import { MessageList } from './components/MessageList';
import { NewGroupDialog } from './components/NewGroupDialog';
import { Sidebar } from './components/Sidebar';
import { takeToken } from './token';
import { useChat } from './useChat';

export function App() {
  const [token] = useState(() => takeToken());
  if (!token) return <NoToken expired={false} />;
  return <Chat token={token} />;
}

function NoToken({ expired }: { expired: boolean }) {
  return (
    <div className="no-token">
      <h1>Agent Chat</h1>
      <p>{expired ? '访问令牌已失效。' : '这个浏览器还没有访问令牌。'}</p>
      <p>
        请用终端里 <code>npm run hub</code> 打印的地址（以 <code>#token=</code> 结尾）重新打开这个页面。
      </p>
    </div>
  );
}

function Chat({ token }: { token: string }) {
  const chat = useChat(token);
  const [dialog, setDialog] = useState(false);
  const { state } = chat;
  if (state.connection === 'unauthorized') return <NoToken expired />;

  const conv = state.conversations.find((c) => c.id === chat.activeId) ?? null;
  const convMembers = conv ? state.members.filter((m) => conv.memberIds.includes(m.id)) : [];
  const candidates = conv?.kind === 'group' ? convMembers.filter((m) => m.kind === 'agent') : [];

  return (
    <div className="app">
      <Sidebar
        state={state}
        activeId={chat.activeId}
        onSelect={chat.select}
        onNewGroup={() => setDialog(true)}
        onRefresh={() => void chat.refreshAvailability()}
      />
      <main className="chat">
        <ChatHeader
          conversation={conv}
          memberNames={convMembers.map((m) => m.name)}
          stopped={state.stopped}
          onTogglePause={() => void chat.togglePause()}
          onStop={() => void chat.stop()}
          onResume={() => void chat.resume()}
        />
        {state.connection === 'hub_down' && (
          <div className="banner" role="status">
            hub 没有运行，请在终端运行 <code>npm run hub</code>，页面会自动重连。
          </div>
        )}
        {conv ? (
          <>
            <MessageList
              messages={state.messages[conv.id] ?? []}
              members={state.members}
              meId={state.me?.id ?? null}
              typingIds={state.typing[conv.id] ?? []}
              hasMore={state.hasMore[conv.id] ?? false}
              onLoadOlder={chat.loadOlder}
            />
            <Composer
              key={conv.id}
              candidates={candidates}
              onSend={chat.send}
              placeholder={conv.kind === 'ask' ? '在这里插话，被问的 agent 会回答' : '发消息，@ 提到成员'}
            />
          </>
        ) : (
          <div className="empty">选择左侧的会话开始聊天</div>
        )}
      </main>
      {dialog && (
        <NewGroupDialog
          agents={state.members.filter((m) => m.kind === 'agent')}
          onClose={() => setDialog(false)}
          onCreate={async (title, ids) => {
            await chat.createGroup(title, ids);
            setDialog(false);
          }}
        />
      )}
    </div>
  );
}
```

把 `packages/web/src/styles.css` 整个替换为：

```css
:root {
  --bg: #f2f2f7;
  --panel: #ffffff;
  --line: #e5e5ea;
  --text: #111111;
  --muted: #8e8e93;
  --faint: #aeaeb2;
  --accent: #007aff;
  --accent-text: #ffffff;
  --bubble-agent: #ffffff;
  --bubble-typing: #e5e5ea;
  --active: #e9e9ee;
  --danger: #ff3b30;
  --code-bg: #1e1e1e;
  --code-text: #d4d4d4;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif;
  font-size: 14px;
  color: var(--text);
  background: var(--bg);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #000000;
    --panel: #1c1c1e;
    --line: #2c2c2e;
    --text: #f2f2f7;
    --muted: #98989d;
    --faint: #636366;
    --accent: #0a84ff;
    --bubble-agent: #2c2c2e;
    --bubble-typing: #3a3a3c;
    --active: #2c2c2e;
    --danger: #ff453a;
  }
}
* { box-sizing: border-box; }
body { margin: 0; }
button { font: inherit; color: inherit; cursor: pointer; }
code { font-family: Menlo, monospace; font-size: 0.92em; }

.app { display: flex; height: 100vh; }

.sidebar { width: 250px; flex: none; display: flex; flex-direction: column; background: var(--panel); border-right: 1px solid var(--line); }
.sidebar-top { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--line); font-size: 15px; }
.new-group { background: var(--accent); color: var(--accent-text); border: 0; border-radius: 7px; padding: 3px 10px; font-size: 12px; }
.sidebar-list { flex: 1; overflow-y: auto; padding: 6px 8px; }
.sidebar-heading { font-size: 11px; color: var(--muted); margin: 12px 8px 4px; }
.sidebar-empty { font-size: 12px; color: var(--faint); padding: 4px 8px; }
.conv { display: flex; align-items: center; gap: 9px; width: 100%; border: 0; background: none; text-align: left; padding: 6px 8px; border-radius: 9px; }
.conv:hover { background: var(--active); }
.conv-active { background: var(--active); font-weight: 600; }
.conv-off { color: var(--faint); }
.conv-text { display: flex; flex-direction: column; min-width: 0; }
.conv-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv-reason { font-size: 11px; font-weight: normal; margin-left: 6px; }
.conv-summary { font-size: 12px; font-weight: normal; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sidebar-foot { display: flex; flex-wrap: wrap; gap: 4px 8px; padding: 9px 14px; border-top: 1px solid var(--line); font-size: 11px; color: var(--muted); }
.link { border: 0; background: none; padding: 0; color: var(--accent); font-size: 11px; }

.avatar { position: relative; flex: none; width: 30px; height: 30px; border-radius: 50%; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; }
.dot { position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--panel); }
.dot-on { background: #34c759; }
.dot-off { background: #c7c7cc; }

.chat { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.chat-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
.chat-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.chat-title h2 { margin: 0; font-size: 15px; }
.chat-members { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat-actions { display: flex; gap: 8px; flex: none; }
.pill { border: 1px solid var(--line); background: var(--panel); border-radius: 14px; padding: 3px 12px; font-size: 12px; }
.pill-on { border-color: var(--accent); color: var(--accent); }
.pill-stop { background: var(--danger); border-color: var(--danger); color: #fff; }
.pill-resume { background: var(--accent); border-color: var(--accent); color: #fff; }
.banner { padding: 8px 16px; background: #fff4e5; color: #8a4b00; font-size: 13px; }
.empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted); }

.messages { flex: 1; overflow-y: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
.load-more { text-align: center; font-size: 12px; color: var(--muted); }
.msg { display: flex; gap: 8px; align-items: flex-start; }
.msg-mine { justify-content: flex-end; }
.msg-col { max-width: 85%; min-width: 0; }
.msg-meta { font-size: 11px; color: var(--muted); margin: 0 0 2px 4px; }
.bubble { border-radius: 17px; padding: 8px 12px; line-height: 1.5; overflow-wrap: anywhere; }
.bubble-mine { background: var(--accent); color: var(--accent-text); max-width: 65%; white-space: pre-wrap; }
.bubble-agent { background: var(--bubble-agent); }
.bubble-typing { background: var(--bubble-typing); color: var(--muted); letter-spacing: 2px; }
.msg-system { align-self: center; font-size: 12px; color: var(--muted); background: var(--bubble-typing); border-radius: 10px; padding: 2px 10px; }

.markdown > :first-child { margin-top: 0; }
.markdown > :last-child { margin-bottom: 0; }
.markdown p { margin: 0.4em 0; }
.markdown a { color: var(--accent); }
.markdown :not(pre) > code { background: var(--bg); padding: 0 4px; border-radius: 4px; }
.markdown pre { margin: 6px 0; background: var(--code-bg); color: var(--code-text); border-radius: 9px; padding: 9px 11px; overflow-x: auto; }
.markdown pre code { font-size: 12.5px; line-height: 1.45; }
.hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: #c586c0; }
.hljs-string, .hljs-attr { color: #ce9178; }
.hljs-number, .hljs-literal { color: #b5cea8; }
.hljs-comment { color: #6a9955; }
.hljs-title, .hljs-function { color: #dcdcaa; }
.hljs-type, .hljs-class { color: #4ec9b0; }

.composer { position: relative; padding: 9px 16px 12px; background: var(--panel); border-top: 1px solid var(--line); }
.composer-row { display: flex; gap: 8px; align-items: flex-end; }
.composer textarea { flex: 1; resize: none; max-height: 160px; border: 1px solid var(--line); border-radius: 19px; padding: 8px 13px; font: inherit; color: var(--text); background: var(--panel); outline: none; }
.composer textarea:focus { border-color: var(--accent); }
.send { width: 34px; height: 34px; border-radius: 50%; border: 0; background: var(--accent); color: #fff; font-size: 16px; }
.send:disabled { opacity: 0.4; cursor: default; }
.composer-hint { font-size: 10px; color: var(--faint); margin: 4px 0 0 14px; }
.composer-error { font-size: 12px; color: var(--danger); margin: 0 0 6px 14px; }
.mention-list { position: absolute; left: 26px; bottom: calc(100% - 4px); margin: 0; padding: 4px; list-style: none; min-width: 190px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12); }
.mention-list li { padding: 5px 9px; border-radius: 6px; cursor: pointer; }
.mention-list li.selected { background: var(--active); }
.mention-list li.off { color: var(--faint); }

.dialog-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.3); display: flex; align-items: center; justify-content: center; }
.dialog { width: 340px; background: var(--panel); border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
.dialog h3 { margin: 0; }
.field { display: flex; flex-direction: column; gap: 6px; border: 0; padding: 0; margin: 0; }
.field input { font: inherit; padding: 6px 9px; border: 1px solid var(--line); border-radius: 8px; color: var(--text); background: var(--panel); }
.check { display: flex; gap: 6px; align-items: center; }
.dialog-error { color: var(--danger); font-size: 13px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
.dialog-actions button { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 5px 14px; }
.dialog-actions .primary { background: var(--accent); border-color: var(--accent); color: #fff; }

.no-token { max-width: 520px; margin: 80px auto; padding: 0 20px; line-height: 1.7; }
```

- [ ] **Step 4: 运行测试、类型检查和构建**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全部 PASS，构建成功。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/useChat.ts packages/web/src/App.tsx packages/web/src/App.test.tsx packages/web/src/styles.css
git commit -m "feat(web): wire the app together with live state, re-sync on reconnect and bubble styles" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 端到端测试（Playwright + 只有假 adapter 的 hub）

**Files:**
- Create: `packages/hub/scripts/e2e-hub.ts`、`packages/web/playwright.config.ts`、`packages/web/e2e/chat.spec.ts`
- Modify: `.gitignore`（加 `test-results/`、`playwright-report/`）

**Interfaces:**
- Consumes: Task 1–12 的全部后端和界面；`npm run e2e`（Task 6 已加）。
- Produces: `npm run e2e` 构建界面、启动端口 4399 的测试 hub（token 固定为 `e2e-token`、两个假 agent `Alpha` 和 `Beta`、临时数据目录），用 chromium 跑全部用例。

- [ ] **Step 0: 忽略 Playwright 的输出目录**

在 `.gitignore` 末尾加两行：

```
test-results/
playwright-report/
```

- [ ] **Step 1: 写测试用 hub**

`packages/hub/scripts/e2e-hub.ts`：

```ts
// Hub for the Playwright tests: two fake agents, a fixed test token, a temp data dir. It never touches
// the keychain, a real agent CLI or the user's data, and never opens a browser.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterError, FakeAdapter } from '@agent-chat/adapters';
import type { InvokeRequest, InvokeResult } from '@agent-chat/adapters';
import { AskService } from '../src/ask';
import { AvailabilityMonitor } from '../src/availability';
import { seed } from '../src/bootstrap';
import { ConfigStore } from '../src/config';
import { Scheduler } from '../src/scheduler';
import { Bus, buildServer } from '../src/server';
import { Store } from '../src/store';

const port = Number(process.env.E2E_PORT ?? 4399);
const TOKEN = 'e2e-token';
const dataDir = mkdtempSync(join(tmpdir(), 'agentchat-e2e-'));

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done, fail) => {
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      fail(new AdapterError('aborted', 'aborted'));
    }, { once: true });
  });

/** Answers "reply from <name>: <last message>" after 300 ms, or 4 s when the message contains SLOW. */
function fake(name: string, displayName: string): FakeAdapter {
  const a = new FakeAdapter(name, displayName);
  a.handler = async (req: InvokeRequest): Promise<InvokeResult> => {
    const last = req.newMessages.at(-1)?.body ?? '';
    await wait(last.includes('SLOW') ? 4000 : 300, req.signal);
    return { kind: 'reply', body: `reply from ${displayName}: ${last}`, harnessSessionId: `${name}-session` };
  };
  return a;
}

const adapters = [fake('fake-a', 'Alpha'), fake('fake-b', 'Beta')];
const store = new Store(join(dataDir, 'agentchat.db'));
seed(store, adapters);
const bus = new Bus();
const monitor = new AvailabilityMonitor(adapters, (e) => bus.emit(e));
await monitor.refresh();
const isAvailable = (n: string) => monitor.map.get(n)?.ok ?? false;
const scheduler = new Scheduler({
  store,
  adapters: new Map(adapters.map((a) => [a.name, a])),
  triage: () => null,
  emit: (e) => bus.emit(e),
  dataDir,
  isAvailable,
});
const ask = new AskService({ store, scheduler, isAvailable, availabilityReason: (n) => monitor.map.get(n)?.reason, emit: (e) => bus.emit(e) });
const app = buildServer({
  store,
  scheduler,
  config: new ConfigStore(dataDir),
  token: () => TOKEN,
  bus,
  availability: monitor.map,
  ask,
  refreshAvailability: () => monitor.refresh(),
  webRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
});
await app.listen({ port, host: '127.0.0.1' });
console.log(`e2e hub listening on http://127.0.0.1:${port}`);
```

- [ ] **Step 2: 写 Playwright 配置**

`packages/web/playwright.config.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const PORT = 4399;

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  workers: 1,
  fullyParallel: false,
  use: { baseURL: `http://127.0.0.1:${PORT}`, browserName: 'chromium' },
  webServer: {
    command: 'npx tsx ../hub/scripts/e2e-hub.ts',
    cwd: here,
    url: `http://127.0.0.1:${PORT}/`,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 30000,
  },
});
```

- [ ] **Step 3: 写端到端用例**

`packages/web/e2e/chat.spec.ts`：

```ts
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const TOKEN = 'e2e-token';
const auth = { authorization: `Bearer ${TOKEN}` };

async function open(page: Page) {
  await page.goto(`/#token=${TOKEN}`);
  await expect(page.getByText('已连接 hub')).toBeVisible();
}
const conv = (page: Page, title: string) => page.getByRole('navigation').getByRole('button', { name: title, exact: true });
const box = (page: Page) => page.getByLabel('消息');
async function send(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press('Enter');
}
async function newGroup(page: Page, title: string, members: string[]) {
  await page.getByRole('button', { name: '＋ 群聊' }).click();
  const dialog = page.getByRole('dialog', { name: '新建群聊' });
  await dialog.getByLabel('群名').fill(title);
  for (const m of members) await dialog.getByLabel(m, { exact: true }).check();
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test('opens with the token, wipes it from the address bar and remembers it', async ({ page }) => {
  await open(page);
  expect(page.url()).not.toContain('token');
  await expect(conv(page, 'Alpha')).toBeVisible();
  await expect(conv(page, 'Beta')).toBeVisible();
  await page.goto('/');
  await expect(page.getByText('已连接 hub')).toBeVisible();
});

test('private chat: typing indicator, then the reply', async ({ page }) => {
  await open(page);
  await conv(page, 'Alpha').click();
  await send(page, 'SLOW 你好-1');
  await expect(page.getByLabel('Alpha 正在输入')).toBeVisible();
  await expect(page.getByText('reply from Alpha: SLOW 你好-1')).toBeVisible({ timeout: 10000 });
  await expect(page.getByLabel('Alpha 正在输入')).toHaveCount(0);
});

test('new group with an @mention: only the mentioned agent answers', async ({ page }) => {
  await open(page);
  await newGroup(page, 'e2e 群', ['Alpha', 'Beta']);
  await box(page).fill('看看这个 @Be');
  await page.getByRole('option', { name: '@Beta' }).click();
  await box(page).press('Enter');
  await expect(page.getByText('reply from Beta: 看看这个 @Beta')).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByText(/reply from Alpha: 看看这个/)).toHaveCount(0);
});

test('pausing a group holds the question until it is resumed', async ({ page }) => {
  await open(page);
  await newGroup(page, 'e2e 暂停群', ['Alpha']);
  await page.getByRole('button', { name: '⏸ 暂停本群' }).click();
  await expect(page.getByRole('button', { name: '▶ 恢复本群' })).toBeVisible();
  await send(page, '@Alpha 暂停中-1');
  await page.waitForTimeout(1500);
  await expect(page.getByText('reply from Alpha: @Alpha 暂停中-1')).toHaveCount(0);
  await page.getByRole('button', { name: '▶ 恢复本群' }).click();
  await expect(page.getByText('reply from Alpha: @Alpha 暂停中-1')).toBeVisible({ timeout: 10000 });
});

test('stop all interrupts a reply in progress; resume answers the question again', async ({ page }) => {
  await open(page);
  await conv(page, 'Beta').click();
  await send(page, 'SLOW 停止-1');
  await expect(page.getByLabel('Beta 正在输入')).toBeVisible();
  await page.getByRole('button', { name: '■ 全部停止' }).click();
  await expect(page.getByRole('button', { name: '▶ 恢复', exact: true })).toBeVisible();
  await expect(page.getByLabel('Beta 正在输入')).toHaveCount(0);
  await page.getByRole('button', { name: '▶ 恢复', exact: true }).click();
  await expect(page.getByText('reply from Beta: SLOW 停止-1')).toBeVisible({ timeout: 10000 });
});

test('an ask between agents shows up, and the human can join in', async ({ page, request }) => {
  await open(page);
  const r = await request.post('/api/ask', { headers: auth, data: { as: 'fake-b', to: 'Alpha', question: 'ask 问题-1' } });
  expect(r.ok()).toBeTruthy();
  await conv(page, 'Beta → Alpha').click();
  await expect(page.getByText('reply from Alpha: ask 问题-1')).toBeVisible();
  await send(page, '插话-1');
  await expect(page.getByText('reply from Alpha: 插话-1')).toBeVisible();
});

test('after the connection drops, the page reconnects and catches up', async ({ page, request }) => {
  let first: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.connectToServer();
    first ??= ws;
  });
  await open(page);
  await conv(page, 'Alpha').click();
  await first!.close();
  await expect(page.getByText('连接中断，正在重连…')).toBeVisible();
  const state = await (await request.get('/api/state', { headers: auth })).json();
  const dm = state.conversations.find((c: { kind: string; title: string }) => c.kind === 'dm' && c.title === 'Alpha');
  await request.post(`/api/conversations/${dm.id}/messages`, { headers: auth, data: { body: '断线时-1' } });
  await expect(page.getByText('reply from Alpha: 断线时-1')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('已连接 hub')).toBeVisible();
});
```

- [ ] **Step 4: 运行端到端测试**

Run: `npm run e2e`
Expected: 7 个用例全部 PASS。chromium 应当复用本机已有的 Playwright 浏览器缓存；如果提示缺浏览器，运行 `npx playwright install chromium` 后重试（这是下载，执行前告诉用户）。如果某个用例失败，按 systematic-debugging 的做法找到根因再修，不要放宽断言。

- [ ] **Step 5: 确认单元测试和类型检查不受影响**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS（`*.spec.ts` 不在 vitest 的 include 里）。

- [ ] **Step 6: Commit**

```bash
git add .gitignore packages/hub/scripts/e2e-hub.ts packages/web/playwright.config.ts packages/web/e2e/chat.spec.ts
git commit -m "test(web): Playwright end-to-end tests against a hub with fake agents" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: README 与最终验收

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 全部前序任务。

- [ ] **Step 1: 更新 README**

1. 把 `## 运行` 一节的命令块改成：

```bash
npm install
npm run build      # 构建网页界面（改过 packages/web 之后要重新运行）
npm run hub
```

并在其后加一段：

```markdown
`npm run hub` 启动后会用默认浏览器打开界面，终端里也会打印界面地址（形如 `http://127.0.0.1:4317/#token=…`）。这个地址里含访问令牌：页面打开后会把令牌存进这个浏览器的 localStorage，并从地址栏里抹掉；以后在同一个浏览器里直接访问 `http://127.0.0.1:4317` 即可，hub 重启也不用重新打开。换浏览器或清除浏览器数据后，需要再用终端里的地址打开一次。设置 `AGENTCHAT_NO_OPEN=1` 时只打印地址、不自动打开浏览器。没有运行过 `npm run build` 时，页面会提示先构建。

界面已知的代价：令牌保存在该浏览器的 localStorage 里；打开浏览器的一瞬间，令牌会出现在 `open` 命令的参数里，同一台机器上的其他进程可以从进程列表看到（与写入钥匙串时相同）。agent 的回答按 Markdown 显示，但不渲染原始 HTML、不加载图片、只保留 http(s) 和 mailto 链接。
```

2. 把 `## 在有界面之前怎么用` 改名为 `## 用 curl 调接口`，并在这一节开头加一句：`界面能做的事都可以直接调接口完成，下面是常用的几个。`
3. 在这一节"给某个私聊发消息"的说明后面加一句：`agent 之间的 ask 会话也可以这样发言：你的消息由被问的 agent 在原来的上下文里回答（提问的 agent 看不到你的插话，但它下次再问时，被问方能看到完整历史）。`
4. 在环境变量那一行加上 `AGENTCHAT_NO_OPEN=1` 的说明。
5. 在 `## 测试` 一节的命令块里加 `npm run e2e   # 构建界面，并用 Playwright 对只有假 agent 的 hub 跑端到端测试`，并说明它使用端口 4399、不调用真实 agent。
6. 加一小节 `### 开发界面`：`npm run web:dev` 启动 Vite 开发服务器（http://localhost:5173），它把 `/api` 和 `/ws` 代理到 4317 端口的 hub；在这个地址后面同样要加 `#token=…` 打开一次。

- [ ] **Step 2: 全量检查**

Run:

```bash
npm test && npm run typecheck && npm run e2e
grep '"resolved"' package-lock.json | grep -vc 'https://registry.npmjs.org/'
git grep -n -i -E "/Users/[a-z]|/home/[a-z]" -- . ':!docs/superpowers/plans/2026-11-13-agent-chat-web-ui.md'
```

Expected: 测试、类型检查、端到端全部 PASS；`grep -c` 输出 `0`；`git grep` 没有输出。

- [ ] **Step 3: 人工验收（需要用户同意后再做）**

先问用户："要用真实的 hub 打开界面，和一个真实 agent 私聊一次吗？这会花一次那个 agent 的额度。"得到同意后，**由用户自己**在自己的终端里运行 `npm run hub`（它会打开浏览器；执行者不要另起 hub，两个 hub 会抢同一个端口，也不要去读含 `#token=` 的输出）。和用户一起按 spec 第 8 节逐条确认：四个私聊和可用状态、私聊发消息看到正在输入和回复、群聊 @、暂停与全部停止、agent 互问会话和插话、hub 重启后页面自动重连且不用重新打开带令牌的地址。验收完请用户在那个终端按 Ctrl+C 停止 hub。

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README covers the web UI, its token handling, dev server and end-to-end tests" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
