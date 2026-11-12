# Agent Chat

本机聊天应用的后端：人和多个 agent（Claude Code、Codex、OpenCode、DSH）在同一处私聊和群聊。

设计文档见 `docs/superpowers/specs/`。

## 运行

需要 Node 22.13 或更高版本。

```bash
npm install
npm run hub
```

中枢监听 `http://127.0.0.1:4317`，只接受本机连接。数据在 `~/Library/Application Support/AgentChat/`。访问令牌在 macOS 钥匙串里（服务名 `AgentChat`，账户名 `hub-token`），不在数据目录的文件里。

环境变量：`AGENTCHAT_PORT` 改端口，`AGENTCHAT_DATA_DIR` 改数据目录。

## 各 agent 的前提

| agent | 前提 |
|---|---|
| Claude Code | 已安装 `claude`，并在终端里运行 `claude` 执行过 `/login` |
| Codex | 已安装并登录 `codex` |
| OpenCode | 已安装并配置好 `opencode` |
| DSH | 已安装 `dsh`；如果 headless 配置的默认模型不可用，在设置里指定 provider 和 model |

中枢会在自己的 OpenCode 工作目录内创建 `opencode.json`（定义只读 agent），不会改动你自己的 OpenCode 配置。

不需要任何 API key，仓库和配置里都没有 API key 字段。

启动时会打印每个 agent 是否可用及原因。

## 设置

设置通过 `PUT /api/config` 写入：

- `triageAgent`：群聊里决定谁发言的 agent（不再需要 API key）。不设置时按 `dsh`、`opencode`、`codex`、`claude` 的顺序取第一个可用的；可以指定为某个 agent 的名字，如 `{"triageAgent":"codex"}`；设为 `null` 或 `"off"` 则关闭，此时群里只有被 @ 的 agent 会回复。代价：每个群聊回合在 agent 发言之前多等几秒到十几秒，因为要先调用一次所选 agent 来判断谁发言。
- `dsh`：DSH 使用的模型，`{ provider, model }`。

## 在有界面之前怎么用

除 `/ws` 外，每个请求都要带请求头 `Authorization: Bearer <token>`。请求只能发往 `127.0.0.1`、`localhost` 或 `[::1]`，其他主机名会被拒绝。

令牌在钥匙串里，取令牌的命令是：

```bash
security find-generic-password -s AgentChat -a hub-token -w
```

下面的示例用 shell 变量保存令牌，不会把它打印出来（默认端口，改过的话请对应修改；需要 `jq`）：

```bash
BASE=http://127.0.0.1:4317
TOKEN=$(security find-generic-password -s AgentChat -a hub-token -w)
```

钥匙串的保护范围（实测）：Codex 的只读沙箱会拦截 `security find-generic-password`；DSH 的沙箱不拦截；Claude Code 和 OpenCode 在聊天里没有 shell，拿不到。所以令牌不是对所有 agent 都不可见，DSH 在聊天里理论上读得到。令牌泄露的后果：持有者可以以你的身份调用中枢的全部接口（读写会话和消息、改设置、唤起各 agent），但只限本机，因为中枢只监听 `127.0.0.1`。另外，中枢写入钥匙串时令牌会短暂出现在 `security` 命令的参数里，同一台机器上的其他进程在那一瞬间可以通过进程列表看到。

查看全部状态（成员、会话、可用性）：

```bash
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/state | jq
```

设置 DSH 使用的模型。如果这台机器上 headless 的默认模型不可用，DSH 在设置之前都会失败：

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"dsh":{"provider":"my-provider","model":"my-provider/deepseek-flash"}}' $BASE/api/config
```

给某个私聊发消息（先从 `/api/state` 的 `conversations` 里取会话 id）：

```bash
CONV=<会话id>
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"body":"你好"}' $BASE/api/conversations/$CONV/messages
```

新建群聊（`memberIds` 是要加入的 agent 成员 id，你自己会自动加入）：

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"讨论组","memberIds":["<成员id1>","<成员id2>"]}' $BASE/api/conversations
```

读取消息（最新的在后，`limit` 最多 200，用 `beforeSeq` 翻更早的）：

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/conversations/$CONV/messages?limit=20" | jq
```

## 让干活中的 agent 进来提问

agent 在自己的软件里干活时，可以通过 MCP 服务向聊天里的其他 agent 提问。MCP 服务（`packages/mcp`）提供两个工具：

- `list_members`：列出可以提问的成员及其简介、是否可用；
- `ask`：向某个成员提问并等待回答（回答可能要一到两分钟，提问超时沿用会话设置 `timeoutMs`，默认 300000 毫秒）。

使用前必须先启动中枢（`npm run hub`），否则工具会提示中枢没有运行。

登记命令：

```bash
npm run connect                # 只预览要做的每一步，不改任何东西
npm run connect -- --apply     # 真正登记
npm run disconnect             # 预览撤销；加 -- --apply 才真正撤销
```

`--apply` 会修改你各软件的全局配置：Codex 的 `~/.codex/config.toml`（并把工具超时设为 600 秒）、Claude Code 的 `~/.claude.json`（用户级）、OpenCode 的 `~/.config/opencode`、DSH 的 `~/.dsh/profiles/*/cordis.patch.yml`。改文件前会各留一份 `.agent-chat.bak` 备份，登记名固定为 `agent-chat`。

`as` 参数（提问者身份）在 `/api/ask` 上由调用方自己声明，任何持有令牌的进程都可以冒用别人的名字；MCP 服务通过启动参数 `--as` 固定自己的身份，但这不是安全边界。

### 隔离

聊天中的 agent 一律只读，并且关闭所有 MCP 服务、插件和连接器，所以被提问的 agent 看不到上面的两个工具，不会互相无限递归。具体做法：Codex 用 `--ignore-user-config --disable apps --disable plugins`；Claude Code 用 `--strict-mcp-config`；OpenCode 用自己定义的 `agentchat` agent，权限默认全部拒绝；DSH 用 `headless` profile。中枢启动的每个子进程还带环境变量 `AGENTCHAT_INVOCATION=1`，MCP 服务看到它就不提供任何工具。

DSH 的例外：DSH 的隔离依赖 `headless` profile 本身没有配置 MCP 服务，`connect` 不会往 `headless` 里写。如果你自己在 `headless` profile 里配了 MCP 服务，聊天时它们会被加载。

冒烟脚本会让每个 agent 回答一个"列出你能用的 MCP 工具"的问题，要求回答 `NO_MCP_TOOLS`。注意这个检查对 OpenCode 偏弱：实测 OpenCode 的默认 agent 在注册了 `agent-chat` 的情况下，仍可能回答 `NO_MCP_TOOLS`（它不把 `tools["agent-chat"].ask` 当作 MCP 工具），所以更可靠的证据是让它列出自己的全部工具名。

### 尚未验证的部分

- Claude Code 的命令行在这台机器上没有登录，涉及 Claude Code 的一切（聊天调用、`--strict-mcp-config` 的隔离效果、`claude mcp add` 的登记、冒烟脚本里的两个新步骤）都没有用真实命令行验证过。
- Claude Code 的 MCP 工具超时是否由环境变量 `MCP_TOOL_TIMEOUT` 控制、是否会被遵守，未验证；`connect` 不改它。如果 `ask` 在 Claude Code 里提前超时，需要自己设置这个环境变量。
- OpenCode：实测 `opencode mcp add`（v2.2.6）写出的是 `mcp.servers.<name>` 结构，而后台服务读取的是 `mcp.<name>`（`type`、`command` 数组、`enabled`）；前者登记后 `opencode mcp list` 显示没有服务，agent 也看不到工具，改成后者后才显示 connected。`connect` 在检查和登记 OpenCode 时依赖这条命令，登记后请自己用 `opencode mcp list` 确认。

## 测试

```bash
npm test                       # 自动测试，不调用真实 agent
npm run smoke -- codex         # 手动冒烟，会调用真实 agent 并产生费用
```

`smoke` 可选 `claude`、`codex`、`opencode`、`dsh`。每个 agent 都会依次跑：`complete()` 原始提问（回答包含 `PONG`）、MCP 隔离（回答 `NO_MCP_TOOLS`）、会话续接、只读强制。DSH 可用 `DSH_SMOKE_MODEL="provider|model"` 指定模型。
