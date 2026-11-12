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

- `triageAgent`：群聊里决定谁发言的 agent（不再需要 API key）。不设置时按 `dsh`、`opencode`、`codex`、`claude` 的顺序取第一个可用的；可以指定为某个 agent 的名字，如 `{"triageAgent":"codex"}`；设为字符串 `"off"` 则关闭，此时群里只有被 @ 的 agent 会回复；设为 `null` 不是关闭，而是恢复上面的自动选择。代价：每个群聊回合在 agent 发言之前多等几秒到十几秒，因为要先调用一次所选 agent 来判断谁发言。
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

登记名固定为 `agent-chat`。`--apply` 会修改你各软件的全局配置，各目标的做法和能否撤销如下：

| 目标 | 改哪里、怎么改 | 备份 | `disconnect` |
|---|---|---|---|
| Codex | 先 `codex mcp remove agent-chat`（忽略失败），再 `codex mcp add`，再直接编辑 `~/.codex/config.toml`（或 `$CODEX_HOME`）把 `tool_timeout_sec` 设为 600 | `config.toml.agent-chat.bak`（只在不存在时创建，不覆盖） | `codex mcp remove agent-chat` |
| Claude Code | `claude mcp remove -s user agent-chat`（忽略失败），再 `claude mcp add -s user`，由 `claude` 自己改 `~/.claude.json` | 没有备份 | `claude mcp remove -s user agent-chat` |
| OpenCode | 直接编辑全局配置（`~/.config/opencode/opencode.json`，只有 `opencode.jsonc` 存在时用它；设了 `XDG_CONFIG_HOME` 则在其下的 `opencode/`），写入 `mcp["agent-chat"] = {type: "local", command: [...], enabled: true, timeout: 600000}`，其余键原样保留，同时清掉旧的 `opencode mcp add` 留下的 `mcp.servers["agent-chat"]` | `opencode.json.agent-chat.bak`（同上，只在不存在时创建） | 只删 `mcp["agent-chat"]`（以及 `mcp.servers["agent-chat"]`），其他条目不动 |
| DSH | 在每个存在的 profile（`web`、`tui`）的 `cordis.patch.yml` 里加一个 `# >>> agent-chat` 标记块 | `cordis.patch.yml.agent-chat.bak`（同上） | 删除标记块，备份保留 |

OpenCode 不用 `opencode mcp add`：实测 OpenCode v2.2.6 的该命令写出 `mcp.servers.<名字>` 结构，OpenCode 并不读取，登记后 `opencode mcp list` 为空、agent 也看不到工具；`mcp["agent-chat"]` 这种写法经实测可用（`opencode mcp list` 显示 connected，默认 agent 能调用 `list_members`）。写入的 `timeout` 是 OpenCode 对 MCP 请求的超时（毫秒），它的默认值只有 5000，对 `ask` 太短。如果 OpenCode 的配置文件带注释（JSONC）或不是合法 JSON，脚本不会改它，而是报错并打印要手工加的条目。

所有被写入的配置文件都通过同目录临时文件加改名的方式原子写入，符号链接会被跟随（链接本身保留，改的是它指向的文件）。重复运行 `connect` 是安全的；如果先删掉旧登记、重新登记却失败了，错误信息会明确说明旧登记已被删除、现在处于缺失状态，以及如何重试。

`as` 参数（提问者身份）在 `/api/ask` 上由调用方自己声明，任何持有令牌的进程都可以冒用别人的名字；MCP 服务通过启动参数 `--as` 固定自己的身份，但这不是安全边界。

### 隔离

聊天中的 agent 一律只读，并且关闭所有 MCP 服务、插件和连接器，所以被提问的 agent 看不到上面的两个工具，不会互相无限递归。具体做法：Codex 用 `--ignore-user-config --disable apps --disable plugins`；Claude Code 用 `--strict-mcp-config`；OpenCode 用自己定义的 `agentchat` agent，权限默认全部拒绝；DSH 用 `headless` profile。中枢启动的每个子进程还带环境变量 `AGENTCHAT_INVOCATION=1`，MCP 服务看到它就不提供任何工具。

DSH 的例外：DSH 的隔离依赖 `headless` profile 本身没有配置 MCP 服务，`connect` 不会往 `headless` 里写。如果你自己在 `headless` profile 里配了 MCP 服务，聊天时它们会被加载。

冒烟脚本对每个 agent 做三个 `complete()` 检查：原始提问（回答包含 `PONG`）、MCP 隔离（回答 `NO_MCP_TOOLS`）、工具清单（列出全部工具名，其中不能出现 `agent-chat`、`agent_chat`、`list_members`、`mcp__`）。

### 尚未验证的部分

- Claude Code 的命令行在这台机器上没有登录，涉及 Claude Code 的一切（聊天调用、`--strict-mcp-config` 的隔离效果、`claude mcp add` 的登记、冒烟脚本里新增的 `complete()` 检查）都没有用真实命令行验证过。
- Claude Code 的 MCP 工具超时是否由环境变量 `MCP_TOOL_TIMEOUT` 控制、是否会被遵守，未验证；`connect` 不改它。如果 `ask` 在 Claude Code 里提前超时，需要自己设置这个环境变量。
- OpenCode 的"聊天时看不到 `agent-chat` 工具"用真实命令行测过：把 `agent-chat` 登记在（临时目录里的）全局配置、适配器的 `opencode.json` 放在另一个工作目录，`agentchat` agent 的工具只有 `glob grep read skill webfetch websearch`，要求它调用 `list_members` 时没有发生任何工具调用，而默认 agent 能调用（通过它的 `execute` 工具）。OpenCode 的 MCP 工具不一定出现在模型自述的工具清单里，所以自述清单本身不是可靠证据，冒烟脚本里 OpenCode 的"MCP 隔离"一步实际上是空洞的（默认 agent 也会回答 `NO_MCP_TOOLS`）；可靠的证据是上面这种"要求它真的去调用"的实测。

## 测试

```bash
npm test                       # 自动测试，不调用真实 agent
npm run smoke -- codex         # 手动冒烟，会调用真实 agent 并产生费用
```

`smoke` 可选 `claude`、`codex`、`opencode`、`dsh`。每个 agent 都会依次跑：`complete()` 的三个检查（原始提问、MCP 隔离、工具清单）、会话续接、只读强制。DSH 可用 `DSH_SMOKE_MODEL="provider|model"` 指定模型。
