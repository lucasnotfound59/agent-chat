# Agent Chat 第二期：MCP 接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Codex、Claude Code、OpenCode、DSH 里干活的 agent 能通过一个 MCP server 向聊天软件里的另一个 agent 提问并同步拿到回答；整个软件不使用任何 API key。

**Architecture:** 中枢新增"提问"通道（`ask` 会话类型，调度器不介入，直接唤起回答者的适配器）；新包 `packages/mcp` 是各软件启动的 stdio MCP server，通过 HTTP 调中枢；点名改为调用某个适配器的一次性原始提问 `complete()`；令牌改存 macOS 钥匙串；聊天时各 harness 的 MCP 全部关闭。

**Tech Stack:** 沿用第一期（Node 24、TypeScript、node:sqlite、Fastify 5、Vitest 2、tsx），新增 `@modelcontextprotocol/sdk`。

## Global Constraints

- 规格：`docs/superpowers/specs/2026-11-12-agent-chat-phase2-mcp-design.md`；第一期规格和计划仍然有效，除非本规格 §5 另有说明。
- 每个任务用 TDD：先写失败的测试并看到它失败，再实现。不得弱化或删除已有断言，除非任务明确要求修改某个期望值。
- 自动测试不得调用真实 agent 命令行、真实网络或真实钥匙串；用临时目录和 `:memory:`。
- 测试输出里只允许出现一条预期的 `ExperimentalWarning: SQLite is an experimental feature`。
- 整个仓库的代码和配置里不得出现任何 API key 字段；`config.json` 不得保存令牌。
- 中枢只监听 `127.0.0.1`；除 `/ws` 外所有路由需要 `Authorization: Bearer <token>`；Host 头只接受 `127.0.0.1`、`localhost`、`[::1]`。
- 聊天中的 agent（包括回答提问和点名）一律只读，并且不加载任何用户配置的 MCP 服务、插件或连接器。
- 中枢唤起的每个子进程都带环境变量 `AGENTCHAT_INVOCATION=1`。
- 钥匙串条目：服务名 `AgentChat`，账户名 `hub-token`。
- MCP server 在各软件里的登记名固定为 `agent-chat`。
- 默认值：提问超时沿用会话设置 `timeoutMs`（300000 毫秒）；登记时工具调用超时 600 秒；中枢端口 4317（环境变量 `AGENTCHAT_PORT`）。
- 本机实测事实（2026-11-12）：
  - Codex 关闭全部 MCP 和连接器需要三个参数一起用：`--ignore-user-config --disable apps --disable plugins`，新会话和 `resume` 都接受。
  - Codex 的只读沙箱拦截 `security find-generic-password`；DSH 的不拦截。
  - `codex mcp add <name> [--env K=V] -- <command...>`；`claude mcp add <name> [-e K=V] -- <command> [args...]`；`opencode mcp add [--global] [--env K=V] <name> -- <command...>`。
  - DSH 的 MCP 服务是 profile 补丁文件里的条目：`name: '@deepseek-ai/dsh-mcp-client'`，`config: { serverName, transport: stdio, command, args, env }`，说明在 `$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-mcp-client/README.zh.md`。
  - Codex 的每个 MCP 服务支持 `tool_timeout_sec`。
- 不得在未经用户明确同意的情况下修改用户各软件的全局配置（`~/.codex`、`~/.claude*`、`~/.config/opencode`、`~/.dsh`）。本计划的自动测试和冒烟都不做这种修改；真实登记只由用户运行 `npm run connect -- --apply`。

## File Structure

```
packages/adapters/src/
  types.ts        + CompleteRequest，AgentAdapter.complete
  cli.ts          + completeCli；invokeCli/completeCli 给子进程加 AGENTCHAT_INVOCATION=1
  codex.ts        + MCP 隔离参数；complete
  opencode.ts dsh.ts claude.ts fake.ts   + complete
packages/hub/src/
  tokenStore.ts   新：TokenStore 接口、KeychainTokenStore、MemoryTokenStore
  config.ts       去掉 token 和 triage；加 triageAgent；迁移旧文件
  types.ts        Conversation.kind 加 'ask'
  ask.ts          新：AskService
  scheduler.ts    忽略 ask 会话；导出供 AskService 复用的唤起入口
  triage.ts       AgentTriage 取代 OpenAITriage
  server.ts       POST /api/ask、GET /api/members；配置接口改 triageAgent；ask 会话拒绝人类发言
  main.ts         接线
packages/mcp/
  package.json
  src/hubClient.ts   调中枢的 HTTP 客户端 + 取令牌
  src/server.ts      buildMcpServer（两个工具）
  src/main.ts        stdio 入口，解析 --as
  src/connect.ts     登记/撤销命令的生成与执行
  test/*.test.ts
packages/hub/scripts/smoke.ts   + complete 步骤、MCP 隔离步骤
README.md
```

---

### Task 1: 适配器的一次性原始提问 `complete()`、子进程环境标记、Codex 的 MCP 隔离

**Files:** Modify `packages/adapters/src/{types,cli,codex,opencode,dsh,claude,fake,index}.ts`；Test `packages/adapters/test/{complete,codex,runProcess}.test.ts`（新增 `complete.test.ts`，其余按需追加）。

**Interfaces — Produces:**
```ts
export interface CompleteRequest { prompt: string; workdir: string; signal: AbortSignal; timeoutMs: number }
// AgentAdapter 新增：
complete(req: CompleteRequest): Promise<string>;   // 新会话、不续接、不带聊天包装；返回去首尾空白后的非空文本，否则抛 AdapterError('crashed')
// cli.ts 新增：
export function completeCli(spec: { cmd: string; args: string[]; stdin?: string }, req: CompleteRequest, parse: ParseOutput): Promise<string>;
export const INVOCATION_ENV = { AGENTCHAT_INVOCATION: '1' };
```

**Requirements:**
- `invokeCli` 和 `completeCli` 调 `runProcess` 时传 `env: { ...process.env, ...INVOCATION_ENV }`（`runProcess` 已会把 `PWD` 设为 `cwd`）。
- `completeCli`：跑子进程，用适配器的 `parse(stdout, null)` 取文本；解析失败按 `invokeCli` 的方式包成 `AdapterError('crashed')`；文本为空抛 `crashed`。不调用 `toResult`，`[[PASS]]` 不做特殊处理。
- 每个命令行适配器的 `complete`：用自己的参数构造函数（`harnessSessionId: null`）和原始 `prompt`。Codex、DSH、Claude 走标准输入；OpenCode 走参数并先 `ensureOpenCodeConfig(workdir)`。为此各 `*Args` 函数若需要一个最小的请求对象，抽出只依赖 `workdir` 和 `harnessSessionId` 的参数类型，不要伪造完整的 `InvokeRequest`。
- `FakeAdapter`：`completeHandler: (req) => Promise<string>` 默认返回 `'{"speakers":[]}'`，并记录 `completeCalls`。
- Codex 参数：新会话为 `exec --json --skip-git-repo-check --ignore-user-config --disable apps --disable plugins -s read-only -C <workdir> -`；续接为 `exec resume --json --skip-git-repo-check --ignore-user-config --disable apps --disable plugins -c sandbox_mode="read-only" <id> -`。更新已有的 Codex 参数测试期望值（这是要求的期望值变更）。

**Tests（至少）：**
- `completeCli` 用 `process.execPath -e` 假命令：返回解析出的文本；空文本抛 `crashed`；子进程环境里 `AGENTCHAT_INVOCATION === '1'` 且 `PWD` 等于 `workdir`。
- `invokeCli` 的子进程同样带该环境变量。
- Codex 新会话和续接参数的精确相等断言。
- 每个适配器 `complete` 所用参数不含会话 ID（对参数构造函数做断言即可，不跑真实命令）。
- `FakeAdapter.complete` 记录调用并返回脚本化结果。

- [ ] 写失败的测试 → 运行确认失败 → 实现 → `npx vitest run packages/adapters && npm run typecheck` 通过 → 提交 `feat(adapters): one-shot complete(), invocation env marker, Codex MCP isolation`

---

### Task 2: 令牌存钥匙串

**Files:** Create `packages/hub/src/tokenStore.ts`；Modify `packages/hub/src/{config,server,main}.ts`、`packages/hub/test/{config,server}.test.ts`、`packages/hub/test/helpers.ts`（如需要）；Test `packages/hub/test/tokenStore.test.ts`。

**Interfaces — Produces:**
```ts
export interface TokenStore { get(): string | null; set(token: string): void }
export class MemoryTokenStore implements TokenStore { constructor(initial?: string | null) }
export class KeychainTokenStore implements TokenStore {
  // run 可注入，默认用 child_process.execFileSync 调 /usr/bin/security
  constructor(run?: (args: string[]) => { status: number; stdout: string })
}
export function ensureToken(store: TokenStore, legacy?: string | null): string;
// AppConfig 变为：{ triageAgent: string | null; dsh: { provider: string; model: string } | null }
// ServerDeps 新增 token: () => string
```

**Requirements:**
- `KeychainTokenStore.get`：`security find-generic-password -s AgentChat -a hub-token -w`，退出码非 0 返回 `null`，成功返回去掉末尾换行的输出。`set`：`security add-generic-password -U -s AgentChat -a hub-token -w <token>`，失败抛出带说明的错误。用 `execFileSync`（不经过 shell）。
- `ensureToken(store, legacy)`：钥匙串里有可用令牌（非空字符串）就返回它；否则若 `legacy` 是非空字符串，写入钥匙串并返回它；否则生成 `randomBytes(24).toString('hex')` 写入并返回。
- `ConfigStore`：不再生成、保存或返回令牌。加载旧文件时若含 `token` 字段，通过新方法 `takeLegacyToken(): string | null` 交出一次，并立刻把文件重写为不含 `token`（和 `triage`）的内容。`config.json` 仍为 `0600`。
- `server.ts`：所有原先读 `config.get().token` 的地方改用 `deps.token()`；`tokenMatches` 逻辑不变。
- `main.ts`：`const tokenStore = new KeychainTokenStore(); const token = ensureToken(tokenStore, config.takeLegacyToken());`；启动信息不再说令牌在 config.json，改为说明令牌在钥匙串（服务名和账户名），不打印令牌本身。
- 测试里的服务器用 `MemoryTokenStore`，绝不碰真实钥匙串。

**Tests（至少）：**
- `KeychainTokenStore` 用注入的 `run`：`get` 成功/失败两种；`set` 传出的参数精确相等；`set` 失败时抛错。
- `ensureToken`：已有、迁移旧令牌、全新生成三种；生成的令牌匹配 `/^[0-9a-f]{48}$/`。
- `ConfigStore`：新建文件不含 `token`；带 `token` 和 `triage` 的旧文件加载后 `takeLegacyToken()` 返回旧值，磁盘文件不再含这两个键，权限仍是 `0600`。
- 已有的服务器鉴权测试全部继续通过（改用注入的令牌）。

- [ ] 写失败的测试 → 确认失败 → 实现 → `npx vitest run packages/hub && npm run typecheck` 通过 → 提交 `feat(hub): keep the access token in the macOS keychain`

---

### Task 3: 点名改走 agent

**Files:** Modify `packages/hub/src/{triage,config,server,main}.ts`、`packages/hub/test/{triage,server}.test.ts`、`packages/hub/test/helpers.ts`。

**Interfaces — Produces:**
```ts
export const TRIAGE_ORDER = ['dsh', 'opencode', 'codex', 'claude'] as const;
export function pickTriageAdapter(
  setting: string | null,                         // config.triageAgent：适配器名、'off' 或 null（自动）
  adapters: Map<string, AgentAdapter>,
  isAvailable: (name: string) => boolean,
): AgentAdapter | null;
export class AgentTriage implements Triage {
  constructor(adapter: AgentAdapter, workdir: string, timeoutMs?: number)   // 默认 60000
}
```

**Requirements:**
- 删除 `OpenAITriage` 及其测试、`TriageConfig`、`config.triage`、`PUT /api/config` 里的 `triage` 处理和 `hasKey`。`parseSpeakers` 和 `Triage`/`TriageInput` 保留。
- `AgentTriage.pick`：把第一期的系统提示词和用户内容拼成一段提示词（末尾要求只输出 JSON `{"speakers": [...]}`），调 `adapter.complete({ prompt, workdir, signal, timeoutMs })`。从返回文本中取出第一个 `{` 到最后一个 `}` 之间的内容交给 `parseSpeakers`（模型可能在 JSON 前后加说明或代码块围栏）；取不到则抛错。
- `pickTriageAdapter`：`'off'` → `null`；指定适配器名 → 该适配器存在且可用则返回，否则 `null`；`null` → 按 `TRIAGE_ORDER` 返回第一个存在且可用的，都没有则 `null`。
- `main.ts`：`triage: () => { const a = pickTriageAdapter(config.get().triageAgent, adapters, isAvailable); return a ? new AgentTriage(a, join(dataDir, 'workspaces', `${a.name}-triage`)) : null; }`，并确保该目录存在。
- `GET/PUT /api/config`：字段为 `{ triageAgent, dsh }`；`triageAgent` 只接受 `null`、`'off'` 或一个已知适配器名，其他值忽略。
- 调度器不改：点名失败或为 `null` 时仍退化为只有被 @ 才回。

**Tests（至少）：**
- `pickTriageAdapter` 的五种情况（off、指定且可用、指定但不可用、自动选第一个可用、全不可用）。
- `AgentTriage` 用 `FakeAdapter`：提示词包含候选成员的名字和介绍、最近消息；返回 `'好的：\n```json\n{"speakers":["B"]}\n```'` 时解析出 B 的 id；返回非 JSON 时抛错；`complete` 抛错时原样传播。
- 一条调度器级测试：`setup` 改为可注入 `AgentTriage`（底层 `FakeAdapter.completeHandler` 返回 `{"speakers":["A"]}`），群里不 @ 任何人发消息后 A 被唤起。
- 配置接口：`PUT {triageAgent:'dsh'}` 后 `GET` 返回它；`PUT {triageAgent:'nope'}` 被忽略；响应里没有任何 key 相关字段。
- 全仓库搜索确认源码中没有 `apiKey`（测试里也没有）。

- [ ] 写失败的测试 → 确认失败 → 实现 → `npm test && npm run typecheck` 通过 → 提交 `feat(hub): triage through a logged-in agent, remove API-key triage`

---

### Task 4: 提问通道

**Files:** Create `packages/hub/src/ask.ts`；Modify `packages/hub/src/{types,store,scheduler,server,main}.ts`；Test `packages/hub/test/ask.test.ts`、追加 `packages/hub/test/server.test.ts`。

**Interfaces — Produces:**
```ts
// types.ts：Conversation.kind: 'dm' | 'group' | 'ask'
export type AskErrorCode = 'bad_request' | 'unavailable' | 'stopped' | 'capped' | 'timeout' | 'failed' | 'aborted';
export class AskError extends Error { constructor(public code: AskErrorCode, message: string) }
export class AskService {
  constructor(deps: { store: Store; scheduler: Scheduler; isAvailable: (adapter: string) => boolean; availabilityReason: (adapter: string) => string | undefined });
  ask(input: { as: string; to: string; question: string; signal: AbortSignal }): Promise<{ reply: string; conversationId: string }>;
}
// scheduler.ts 新增公开方法：
invokeForAsk(conversationId: string, agentMemberId: string, signal: AbortSignal): Promise<
  | { kind: 'reply'; body: string }
  | { kind: 'silent' }
  | { kind: 'timeout' | 'error' | 'aborted' | 'capped' | 'stopped'; message: string }>;
// store.ts 新增：findAskConversation(askerId: string, targetId: string): Conversation | null
```

**Requirements:**
- `ask` 会话：`kind: 'ask'`，成员恰好是提问者和回答者，标题 `"<提问者名> → <回答者名>"`。同一有序对只建一个（需要能区分方向：在会话 `settings` 之外另存不合适，用标题加成员判断不可靠——给 `conversations` 表加可空列 `ask_from TEXT`、`ask_to TEXT`，并在 `Store` 构造时对已有数据库做兼容的 `ALTER TABLE ... ADD COLUMN`（列已存在则跳过）；`findAskConversation` 按这两列查）。
- 调度器：`onMessage`、`kick`、`runRound`、`resumeAll` 对 `kind === 'ask'` 的会话一律不处理。
- `Scheduler.invokeForAsk`：复用 `invokeAgent` 的内部逻辑（唤起记录、typing 事件、会话续接与失效重试、回复落库并发事件、超时/出错的系统消息），但不设置轮次状态。全局停止时返回 `stopped`；超过每日上限返回 `capped`（并按现有规则发一次系统提示）；`[[PASS]]` 不适用（`ask` 会话按私聊处理，`isGroup: false`）。同一会话的调用串行：用每会话的 promise 链排队。调用方的 `signal` 中止时中止子进程并返回 `aborted`。`stopAll()` 也要中止正在进行的提问。
- `AskService.ask`：
  1. 校验：`question` 去空白后非空；`as` 是某个 agent 成员的适配器名；`to` 按成员名或适配器名解析为 agent 成员；不是同一个成员。否则 `AskError('bad_request', 中文说明)`。
  2. 回答者适配器不可用 → `AskError('unavailable', '<名字> 现在不可用：<原因>')`。
  3. 找到或创建 `ask` 会话；存问题为提问者的消息，`meta: { via: 'mcp' }`；发 `message` 事件（新建会话时先发 `conversation` 事件）。
  4. `scheduler.invokeForAsk`；把结果映射为返回值或 `AskError`（`silent` 视为 `failed`，说明"对方没有给出回答"）。
- `POST /api/ask`：请求体 `{ as, to, question }`；状态码映射：`bad_request` 400、`unavailable` 409、`stopped` 503、`capped` 429、`timeout` 504、`failed` 502、`aborted` 499；错误体 `{ error: <中文说明>, code }`。请求连接在完成前关闭时中止（监听 `request.raw` 的 `close` 且响应尚未发送）。
- `GET /api/members`：`[{ name, adapter, kind, bio, available, reason }]`，人类成员的 `adapter` 为 `null`、`available` 为 `true`。
- `POST /api/conversations/:id/messages` 对 `ask` 会话返回 400（本期人类不能往里发言）。
- `main.ts`：创建 `AskService` 并传给 `buildServer`。

**Tests（至少）：**
- 第一次提问创建会话（标题、成员、kind）、存两条消息（问题带 `meta.via === 'mcp'`）、返回回答；第二次提问复用同一会话，回答者拿到的 `harnessSessionId` 是上次的，`newMessages` 只含新问题。
- 反方向（B 问 A）是另一个会话。
- 提问结束后推进假时钟，调度器没有任何后续唤起（提问者不会被拉来回答）。
- 同一会话两个并发提问按顺序处理（第二个的适配器调用在第一个结束后才开始）。
- `as`/`to` 无效、问自己、问人类、空问题 → `bad_request`；回答者不可用 → `unavailable`，且没有创建会话或消息。
- 全局停止时 → `stopped`；`stopAll()` 中止进行中的提问 → `aborted`。
- 每日上限为 0 → `capped`。适配器超时 → `timeout` 且会话里有系统消息；适配器 `crashed` → `failed`。
- 调用方 `signal` 中止 → 适配器的 `signal.aborted` 为真，唤起记录为 `interrupted`。
- 路由：成功 200；各错误码的 HTTP 状态；无令牌 401；`GET /api/members` 的形状；往 `ask` 会话 POST 消息 → 400。
- 旧数据库兼容：用第一期的建表语句建一个文件库，再用新 `Store` 打开，不报错且 `findAskConversation` 可用。

- [ ] 写失败的测试 → 确认失败 → 实现 → `npm test && npm run typecheck` 通过 → 提交 `feat(hub): ask channel — one agent asks another and waits for the answer`

---

### Task 5: MCP server

**Files:** Create `packages/mcp/package.json`、`packages/mcp/src/{hubClient,server,main}.ts`；Test `packages/mcp/test/{hubClient,server}.test.ts`；Modify 根 `package.json`（脚本）、`tsconfig.json`（如需）。

**Interfaces — Produces:**
```ts
// hubClient.ts
export interface HubClient {
  listMembers(): Promise<{ name: string; adapter: string | null; kind: string; bio: string; available: boolean; reason?: string }[]>;
  ask(to: string, question: string, signal?: AbortSignal): Promise<string>;
}
export class HubUnreachableError extends Error {}
export function createHubClient(opts: { baseUrl: string; as: string; getToken: () => string | null; fetchImpl?: typeof fetch }): HubClient;
export function readTokenFromKeychain(run?: (args: string[]) => { status: number; stdout: string }): string | null;
// server.ts
export function buildMcpServer(opts: { as: string; client: HubClient; invokedByHub: boolean }): McpServer;
```

**Requirements:**
- 依赖 `@modelcontextprotocol/sdk`（安装时用 `npm install --fetch-timeout=60000 --fetch-retries=5 -w @agent-chat/mcp @modelcontextprotocol/sdk`）。先读已安装版本的类型定义和 README，按该版本的 API 写，不要凭记忆。
- `main.ts`：解析 `--as <适配器名>`（缺失则向 stderr 打印用法并以 2 退出）；`baseUrl = http://127.0.0.1:${AGENTCHAT_PORT ?? 4317}`；`invokedByHub = process.env.AGENTCHAT_INVOCATION === '1'`；用 stdio 传输启动。stdout 只能用于协议，日志一律写 stderr。
- 工具（`invokedByHub` 为真时不注册任何工具）：
  - `list_members`：无参数。返回文本，每行一个可提问的成员：名字、介绍、是否可用（不可用带原因）；不列人类和调用者自己。
  - `ask`：参数 `to`（成员名）、`question`。返回对方的回答文本。
  - 工具说明用英文写明：何时使用（卡住、需要另一个模型的看法或复核时）；提问必须自带必要背景，因为对方看不到你的工作区和对话；一次调用可能要等一到两分钟；先用 `list_members` 看有谁。
- 出错时工具返回 `isError: true` 和一句话：连不上中枢或没有令牌 → `Agent Chat hub is not running. Ask the user to start it (npm run hub), then try again.`；中枢返回的错误体 → 原样给出其中的 `error` 文本。不重试。
- `createHubClient`：请求头带 `Authorization: Bearer <token>`；`ask` 为 `POST /api/ask`，`AbortSignal.timeout(600000)` 与传入的 `signal` 合并；网络错误或 `getToken()` 为 `null` 抛 `HubUnreachableError`；非 2xx 抛带 `error` 文本的普通 `Error`。
- 根 `package.json` 增加脚本 `"mcp": "tsx packages/mcp/src/main.ts"`。

**Tests（至少）：**
- `createHubClient` 用假 `fetch`：请求的 URL、方法、头、体；`as` 进了请求体；非 2xx 给出 `error` 文本；网络错误和无令牌 → `HubUnreachableError`。
- `readTokenFromKeychain` 用注入的 `run`。
- `buildMcpServer` 用 SDK 自带的内存传输对接一个 SDK 客户端：`tools/list` 返回两个工具；调 `list_members` 得到不含调用者和人类的列表；调 `ask` 得到假客户端的回答；客户端抛 `HubUnreachableError` 时结果为 `isError` 且文本是上面那句；`invokedByHub: true` 时 `tools/list` 为空。
- 一条进程级测试：用 `process.execPath` 配合 tsx 启动 `main.ts`（设 `AGENTCHAT_PORT` 指向一个测试里起的假 HTTP 服务器，令牌读取通过环境变量 `AGENTCHAT_TOKEN_FOR_TESTS` 注入——`main.ts` 仅在该变量存在时用它代替钥匙串，并在代码注释里写明只供测试），通过 stdio 完成 initialize 和一次 `ask`。缺少 `--as` 时退出码为 2。

- [ ] 写失败的测试 → 确认失败 → 实现 → `npm test && npm run typecheck` 通过 → 提交 `feat(mcp): stdio MCP server with list_members and ask`

---

### Task 6: 登记脚本

**Files:** Create `packages/mcp/src/connect.ts`；Test `packages/mcp/test/connect.test.ts`；Modify 根 `package.json`。

**Interfaces — Produces:**
```ts
export type Target = 'codex' | 'claude' | 'opencode' | 'dsh';
export interface Step { target: Target; description: string; run: () => Promise<void> | void; display: string }
export function planConnect(opts: { targets: Target[]; repoRoot: string; home: string; nodePath: string; dshProfiles: string[] }): Step[];
export function planDisconnect(opts: 同上): Step[];
export function upsertDshEntry(yaml: string, entry: string): string;   // 带标记的幂等插入
export function removeDshEntry(yaml: string): string;
```

**Requirements:**
- MCP server 的启动命令统一为：`<node 绝对路径> --import <repoRoot>/node_modules/tsx/dist/loader.mjs <repoRoot>/packages/mcp/src/main.ts --as <target>`（先确认本机 tsx 版本的 loader 路径存在，按实际路径写；不依赖 `npx` 和 PATH）。
- 各目标的登记（实施前对每条命令看一次该软件的 `--help`，以实际为准）：
  - Codex：`codex mcp add agent-chat -- <命令>`，然后把 `tool_timeout_sec = 600` 设到 `mcp_servers.agent-chat`（若 `codex mcp add` 无此选项，则对 `~/.codex/config.toml` 中该服务的表做最小的文本追加，且只在该表内）。
  - Claude Code：`claude mcp add -s user agent-chat -e MCP_TOOL_TIMEOUT=600000 -- <命令>`（先核实用户级作用域和超时的正确写法）。
  - OpenCode：`opencode mcp add --global agent-chat -- <命令>`（核实是否有超时设置）。
  - DSH：对 `dshProfiles`（默认 `web` 和 `tui` 中实际存在的）各自的 `cordis.patch.yml`，用 `upsertDshEntry` 插入一段以 `# >>> agent-chat` 和 `# <<< agent-chat` 包住的条目；先把原文件备份为同目录下 `cordis.patch.yml.agent-chat.bak`（已存在则不覆盖）。条目内容按 DSH 的 mcp-client 说明书写，包含其支持的超时字段（若有）。
- 撤销：对应的 `mcp remove`（或等价命令）；DSH 用 `removeDshEntry` 删掉标记之间的内容。
- 命令行：`npm run connect [-- --apply] [codex] [claude] [opencode] [dsh]`、`npm run disconnect [-- --apply] [...]`。不带 `--apply` 时只打印将要执行的每一步（`display`）并退出，什么都不改。未安装的软件跳过并说明。带 `--apply` 时逐步执行并打印每步结果；某一步失败不影响其他目标，最后以非 0 退出。
- 只增删名为 `agent-chat` 的条目，不动其他配置。

**Tests（至少）：** 不执行任何真实命令、不碰真实主目录。
- `planConnect`/`planDisconnect` 对每个目标生成的 `display` 精确相等（用固定的假 `repoRoot`、`home`、`nodePath`）。
- `upsertDshEntry`：空文件、已有其他条目的文件、已含旧标记块的文件（替换而不是重复）；`removeDshEntry` 还原为插入前的内容（逐字节相等）。
- 用临时目录当 `home`，对 DSH 步骤调用 `run()`：生成备份、写入条目、再次运行幂等；撤销后文件与原文件逐字节相等。
- 不带 `--apply` 运行入口：退出码 0，输出包含各步骤，临时 `home` 下没有任何文件被修改（通过环境变量把 `home` 指到临时目录；入口必须支持 `AGENTCHAT_CONNECT_HOME` 用于测试，并且对 Codex/Claude/OpenCode 的命令在测试中不被执行）。

- [ ] 写失败的测试 → 确认失败 → 实现 → `npm test && npm run typecheck` 通过 → **不要运行 `--apply`** → 提交 `feat(mcp): connect and disconnect scripts for registering the MCP server`

---

### Task 7: OpenCode 的 MCP 隔离、冒烟脚本、README

**Files:** Modify `packages/adapters/src/opencode.ts`（如实测需要）、`packages/adapters/test/opencode.test.ts`、`packages/hub/scripts/smoke.ts`、`README.md`。

**Requirements:**
1. **OpenCode 隔离实测**（在暂存目录里做，不改全局配置）：在一个临时目录里运行 `opencode mcp add agent-chat -- <Task 6 的启动命令，--as opencode>`（不带 `--global`，写项目配置），再放入适配器生成的 `opencode.json` 内容（两者需要合并成一个文件——弄清 `ensureOpenCodeConfig` 与项目级 MCP 配置如何共存），然后用 `--agent agentchat` 让模型列出它能用的全部 MCP 工具。判定：列不出 `agent-chat` 的工具。若列得出，在 `agentchat` 的配置里找到能禁掉 MCP 工具的写法（权限规则或 MCP 开关），更新 `openCodeConfig()` 和它的测试，再测，直到判定通过。把实测的输入输出写进报告。
2. **冒烟脚本**新增两步，四个 agent 都有：
   - "原始提问"：`adapter.complete({ prompt: 'Reply with exactly: PONG', ... })`，回答包含 `PONG` 才通过。
   - "MCP 隔离"：`adapter.complete` 提问 `List the exact names of every MCP tool or MCP server available to you in this session (tools whose names start with mcp__ or that come from external servers, apps or connectors). If there are none, reply exactly: NO_MCP_TOOLS. Do not call any tool.`，回答去空白后等于 `NO_MCP_TOOLS` 才通过；否则 FAIL 并打印回答。
3. 重跑真实冒烟，每个 agent 一次（改过其适配器的最多两次）：`npm run smoke -- codex`、`npm run smoke -- opencode`、`DSH_SMOKE_MODEL="my-provider|my-provider/deepseek-flash" npm run smoke -- dsh`。不跑 `claude`（未登录），不尝试登录。把完整输出贴进报告。任何一步 FAIL 都是发现：不改检查，查明原因；能修适配器就修并重测，否则带证据报告。
4. **README** 更新：
   - 令牌在钥匙串：取令牌的命令 `security find-generic-password -s AgentChat -a hub-token -w`，所有 curl 示例改用它；说明钥匙串的保护范围（Codex 的沙箱拦截、DSH 的不拦截、Claude Code 和 OpenCode 在聊天里没有 shell），以及泄露的后果范围。
   - 不再需要任何 API key；点名由哪个 agent 做、如何用 `PUT /api/config {"triageAgent": ...}` 指定或关闭，以及代价（每轮多等几秒到十几秒）。
   - "让干活中的 agent 进来提问"一节：`npm run connect` 先预览、`npm run connect -- --apply` 才真正登记、`npm run disconnect` 撤销；它会改哪些文件；两个工具的用途；中枢需要先启动。
   - 聊天时各 harness 的 MCP、插件、连接器全部关闭，以及 DSH headless 配置的例外说明。

- [ ] 实测 → 按需修适配器（TDD）→ 改冒烟脚本 → 跑冒烟 → 改 README → `npm test && npm run typecheck` 通过 → 提交

---

### Task 8: 真实软件间的端到端验证（不修改用户全局配置）

**Files:** 仅报告；如发现缺陷，修对应文件并补测试。

**Requirements:**
- 用临时数据目录和端口启动中枢：`AGENTCHAT_DATA_DIR="$(mktemp -d)" AGENTCHAT_PORT=4396`。注意中枢会把令牌写进真实钥匙串的 `AgentChat/hub-token` 条目——这是本期设计的行为，可以接受；若该条目此前不存在，验证结束后保留它（中枢以后还要用）。
- 设置 DSH 模型：`PUT /api/config {"dsh":{"provider":"my-provider","model":"my-provider/deepseek-flash"}}`。
- **不运行 `connect --apply`。** 改用只对单次运行生效的方式把 MCP server 挂给一个"正在干活"的 Codex：在一个临时工作目录里运行
  `codex exec --json --skip-git-repo-check -s read-only -c 'mcp_servers.agent-chat.command="<node>"' -c 'mcp_servers.agent-chat.args=[...]' -c 'mcp_servers.agent-chat.env={AGENTCHAT_PORT="4396"}' -c 'mcp_servers.agent-chat.tool_timeout_sec=600' "<提示词>"`
  （按 codex 实际接受的 TOML 覆盖写法调整；这次运行不带 `--ignore-user-config`，因为它扮演的是用户自己的工作会话）。提示词：先调用 `list_members`，再用 `ask` 问 OpenCode 一个自带背景的具体技术问题，最后原样复述 OpenCode 的回答。
- 判定：Codex 的输出里有来自 OpenCode 的回答；`GET /api/state` 里出现标题为 `Codex → OpenCode` 的 `ask` 会话；该会话的消息里有问题（`meta.via` 为 `mcp`）和回答；之后 60 秒内没有任何额外的唤起记录。
- 再做一次 `ask` 问 DSH，确认同样成立。
- 套娃检查：确认回答者（OpenCode、DSH）在回答时拿不到 `agent-chat` 的工具——从中枢的唤起记录和会话消息判断没有产生反向的 `ask` 会话。
- 群聊点名的真实验证：建一个含 Codex、OpenCode、DSH 的群，发一条不 @ 任何人但明显指向编程问题的消息，确认至少一个 agent 被点名并回复，且对话在轮数上限内停下。记录点名用的是哪个 agent 以及每轮耗时。
- 结束后用 SIGINT 停掉中枢，确认没有残留进程。
- 每个真实 agent 的调用次数尽量少；整个任务的真实调用控制在 15 次以内。

- [ ] 执行 → 把命令、关键输出、耗时写进报告 → 如有修复则提交

---

## 本计划之后

- 用户自己运行 `npm run connect -- --apply` 完成真实登记（或明确同意后由助手代为运行）。
- Claude Code 的验证取决于其命令行登录。
- 网页界面计划，开头的"后端前置"任务包含：第一期最终审查列出的界面前置项、"按 agent 打开聊天 MCP"的开关、人类在 `ask` 会话里发言。
