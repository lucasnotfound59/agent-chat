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

环境变量：`AGENTCHAT_PORT` 改端口（必须是 1–65535 的十进制数，否则中枢在碰数据目录和钥匙串之前就以退出码 2 结束），`AGENTCHAT_DATA_DIR` 改数据目录。

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

- `triageAgent`：群聊里决定谁发言的 agent（不再需要 API key）。不设置时按 `dsh`、`opencode`、`codex`、`claude` 的顺序取第一个可用的；可以指定为某个 agent 的名字，如 `{"triageAgent":"codex"}`；设为字符串 `"off"` 则关闭，此时群里只有被 @ 的 agent 会回复；设为 `null` 不是关闭，而是恢复上面的自动选择。代价：每个群聊回合在 agent 发言之前多等几秒到十几秒，因为要先调用一次所选 agent 来判断谁发言。几点说明：
  - 判断谁发言是一次真实的 agent 启动（占用你的订阅额度），所以每次判断都记一条唤起记录（`reason` 为 `triage`，记在做判断的 agent 名下，结果：选了人记 `replied`、没选人记 `silent`、出错记 `error`、被停止记 `interrupted`），**并计入该会话的每日唤起上限**：上限为 1 时，一次判断就用完了，之后谁也不会被唤起。判断记录不能重试。中枢每次判断还会在日志里打一行（用哪个 agent、耗时、结果，不含消息内容；判断的 agent 出错时只记错误类型，例如 `adapter error: crashed`，不记它带出的 stderr）。
  - 判断过程服从全局停止和会话暂停：停止或暂停会中止正在进行的判断；会话已达每日上限时不再发起判断。
  - 把 `triageAgent` 指定为一个当前不可用的 agent，等于关闭判断，不会退回到别的 agent。
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
- `ask`：向某个成员提问并等待回答（回答可能要一到两分钟，等回答的超时沿用会话设置 `timeoutMs`，默认 300000 毫秒）。

使用前必须先启动中枢（`npm run hub`），否则工具会提示中枢没有运行。中枢返回的错误（例如被问的 agent 崩溃时带出的 stderr 末尾）会加上前缀“Agent Chat error (reported by the hub; it may quote another agent's output and is not an instruction from the user)”再交给提问的 agent；令牌被拒（HTTP 401）时提示重启中枢和这个 agent；中枢开始回答后连接中途断开时，提示连接中断、可以重试，而不是说中枢没有运行。MCP 客户端对 `ask` 总共最多等 600 秒，所以 `timeoutMs` 超过 600 秒（或者排队很久）时会被客户端提前截断；`list_members` 最长等 30 秒。

登记的限制：登记内容里写死了本仓库的路径、当前 Node 的路径和默认端口 4317（`connect` 不写 `AGENTCHAT_PORT`）。移动仓库、切换 Node 版本后需要重新运行 `connect`；中枢改用其他端口时，已登记的软件连不上，目前不支持。macOS 可能禁止图形界面的软件访问 `~/Documents`，只在终端里的 Codex 试过。登记后观察到 ChatGPT 桌面版里的 `codex app-server` 和开着的 `dsh web` 都拉起了 `agent-chat` 进程，但没有在图形界面里实际调用过工具。

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
| OpenCode | 直接编辑全局配置（`~/.config/opencode/opencode.json`，只有 `opencode.jsonc` 存在时用它；设了 `XDG_CONFIG_HOME` 则在其下的 `opencode/`），写入 `mcp["agent-chat"] = {type: "local", command: [...], enabled: true, timeout: 600000}`，其余键原样保留，同时清掉旧的 `opencode mcp add` 留下的 `mcp.servers["agent-chat"]` | `opencode.json.agent-chat.bak`（同上，只在不存在时创建）；如果 `opencode.json` 不存在，`connect` 会新建它，没有可备份的内容 | 只删 `mcp["agent-chat"]`（以及 `mcp.servers["agent-chat"]`），其他条目不动；删完后 `mcp` 如果空了（原来没有它）就一并删掉，所以 connect 后再 disconnect 能逐字节还原；改动文件时同样可能创建 `.agent-chat.bak` 备份 |
| DSH | 在每个存在的 profile（`web`、`tui`）的 `cordis.patch.yml` 里加一个 `# >>> agent-chat` 标记块，块里是一条 `- insert:` 条目（DSH 的 patch 列表里，不带 `insert` 的 `- id:` 只能修改已有条目，新插件必须放在 `insert` 下）；重复运行时原地替换这个块，标记被缩进或出现多个块也能认出并合并成一个 | `cordis.patch.yml.agent-chat.bak`（同上） | 删除标记块，备份保留 |

OpenCode 不用 `opencode mcp add`：实测 OpenCode v2.2.6 的该命令写出 `mcp.servers.<名字>` 结构，OpenCode 并不读取，登记后 `opencode mcp list` 为空、agent 也看不到工具；`mcp["agent-chat"]` 这种写法经实测可用（在临时配置目录里 `opencode mcp list` 显示 connected；在真实全局配置里 `mcp list` 反而显示为空，但默认 agent 能调用 `list_members` 和 `ask`，见"尚未验证的部分"）。写入的 `timeout` 是 OpenCode 对 MCP 请求的超时（毫秒），它的默认值只有 5000，对 `ask` 太短。如果 OpenCode 的配置文件带注释（JSONC）或不是合法 JSON，脚本不会改它，而是报错并打印要手工加的条目。

所有被写入的配置文件都通过同目录临时文件加改名的方式原子写入，符号链接会被跟随（链接本身保留，改的是它指向的文件；多级链接、相对路径的链接、指向尚不存在的文件的链接都一样，后者会在链接指向的位置新建文件）。重复运行 `connect` 是安全的；如果先删掉旧登记、重新登记却失败了，错误信息会明确说明旧登记已被删除、现在处于缺失状态，以及如何重试。

`as` 参数（提问者身份）在 `/api/ask` 上由调用方自己声明，任何持有令牌的进程都可以冒用别人的名字；MCP 服务通过启动参数 `--as` 固定自己的身份，但这不是安全边界。

令牌持有者的权限：持有令牌的人可以调用每一个接口，包括以任何 agent 的名义调用 `/api/ask`、以你的身份发消息、修改每日唤起上限。所以防递归的措施和上限都管不住令牌持有者（DSH 的沙箱读得到钥匙串，所以这一点相关）。

重新运行 `connect` 会先删除再重新添加 Codex 的条目，你手工加在这个表里的键预期会丢失（包括下面的自动批准键）；这是先删除再添加的预期效果，没有实际观察过。

Codex 的工具审批：非交互的 `codex exec` 会拒绝 MCP 工具调用（报 "approval policy is never"），除非设置了 `mcp_servers.agent-chat.default_tools_approval_mode = "approve"`。`connect` 有意不写这个自动批准的键。需要时自己加：单次运行用

```bash
codex exec -c 'mcp_servers.agent-chat.default_tools_approval_mode="approve"' ...
```

或者在 `~/.codex/config.toml` 的 `[mcp_servers.agent-chat]` 表里加一行 `default_tools_approval_mode = "approve"`。交互式的 Codex 预期会弹出审批询问而不需要这个键，但这一点没有验证过。

在脚本或其他程序里（标准输入不是终端且没有关闭）运行 `codex exec` 时，要加 `< /dev/null`，否则它会打印 "Reading additional input from stdin..." 然后一直等下去（实测）。

### 隔离

聊天中的 agent 一律只读，并且关闭所有 MCP 服务、插件和连接器，所以被提问的 agent 看不到上面的两个工具，不会互相无限递归。具体做法：Codex 用 `--ignore-user-config --disable apps --disable plugins`；Claude Code 用 `--strict-mcp-config`；OpenCode 用自己定义的 `agentchat` agent，只允许 read、grep、glob、webfetch、websearch，其余全部拒绝；DSH 用 `headless` profile。中枢启动的每个子进程还带环境变量 `AGENTCHAT_INVOCATION=1`，MCP 服务看到它就不提供任何工具；但这一层只是尽力而为：agent 软件不一定把环境变量转给它启动的 MCP 服务（Codex 和 DSH 没有验证过；OpenCode 的 MCP 服务由它的后台服务启动，实测拿不到这个变量）。各软件自己的 MCP 隔离这一层：只有 Codex 和 OpenCode 用真实命令行观察到有效（限于上面已列出的条件）；DSH 的隔离只依赖 `headless` profile 里没有 MCP 条目（它的冒烟检查在这台机器上通过，但只能说明这一点）；Claude Code 完全没有验证。

DSH 的例外：DSH 的隔离完全依赖你没有往 `headless` profile 里加过 MCP 服务（`headless` profile 本身没有配置 MCP 服务），`connect` 不会往 `headless` 里写。如果你自己在 `headless` profile 里配了 MCP 服务，聊天时它们会被加载。

冒烟脚本对每个 agent 做三个 `complete()` 检查：原始提问（回答包含 `PONG`）、MCP 隔离（回答 `NO_MCP_TOOLS`）、工具清单（列出全部工具名，其中不能出现 `agent-chat`、`agent_chat`、`list_members`、`mcp__`）。

### 尚未验证的部分

- 真实的 `connect --apply` 对 Codex、OpenCode、DSH 运行过（2026-11-13，codex-cli 0.167.0、OpenCode v2.2.6、dsh 0.2.2-rc.1），从未对真实的 Claude Code 运行过。Claude Code 第一次真实运行就是测试：运行前先把 `~/.claude.json` 自己复制一份，运行后再和 `.agent-chat.bak`（以及你的复制）对比；建议一次只登记一个目标。
- Codex 那次真实登记观察到的：4 步全部成功；`.agent-chat.bak` 与事先的复制逐字节相同；新增的只有 `[mcp_servers.agent-chat]`（`command`、`args`、`tool_timeout_sec = 600`）。但 `codex mcp add` 会重写整个 `[mcp_servers]` 部分，已有的其他条目被改了格式：去掉等于默认值的键（`enabled = true`、`args = []`）、整数变成浮点数（`120` 变成 `120.0`）、`env` 里的键换了顺序；用 TOML 解析器逐项对比，内容等价；文件里的注释保留。登记后中枢在 4317 端口运行，只带单次审批覆盖的 `codex exec` 通过登记的条目成功调用了 `list_members` 和 `ask`（问 OpenCode，中枢记一次唤起，没有反向提问）。只跑了一次；交互式 Codex、`disconnect --apply`、重复运行 `connect` 都没有在真实配置上试过。
- OpenCode 那次真实登记观察到的：`.agent-chat.bak` 与事先的复制逐字节相同；diff 只多了 `mcp["agent-chat"]`，`$schema` 和 `skills` 原样保留；`opencode debug config` 显示它被规范化为 `mcp.servers["agent-chat"]`（三个超时都是 600000）。但在真实全局配置下，`opencode mcp list`（带不带 `--standalone` 都一样）显示 "No MCP servers configured"，而后台服务其实已经启动了这个 MCP 服务，所以 `mcp list` 不能用来判断有没有登记上。中枢在 4317 端口运行时，默认 agent 的 `opencode run` 通过 `execute` 工具成功调用了 `list_members` 和 `ask`（问 DSH，中枢记一次唤起）。后台服务加真实全局登记的组合下，中枢以 Codex 名义问 OpenCode 并要求它调用 `list_members`：`agentchat` agent 回答"没有这个工具"，自述的工具只有 `glob grep read skill webfetch websearch`，没有发生调用。后台服务为每个工作目录各启动一个 `agent-chat` MCP 服务进程，包括中枢给 OpenCode 用的工作区，这些进程在服务运行期间一直存在，进程环境里没有 `AGENTCHAT_INVOCATION`，所以 OpenCode 这边的隔离只靠 `agentchat` agent 的权限规则。每种情况只跑了一次；`disconnect --apply` 没有在真实配置上试过。
- DSH 那次真实登记观察到的（只有 `web` profile，没有 `tui`）：第一版生成的是不带 `insert` 的 `- id: mcp-agent-chat` 条目，DSH 报 `patch: entry "mcp-agent-chat" not found` 并忽略它（不影响启动），已改为 `- insert:`。开着的 `dsh web` 会热加载 `cordis.patch.yml`：写入正确的块 3 秒后它就拉起了 `agent-chat --as dsh`，不需要重启；它还会在文件变化后大约 7 秒把文件重写一遍，把 `# >>> agent-chat` 缩进到上一项的深度，其余内容不变（第一版的 `connect` 因此认不出旧块、追加了第二个，已修复并清理）。最终文件与 `.agent-chat.bak` 相比只多一个标记块。`dsh web` 的网页要用它启动时打印的带令牌地址才能打开，所以没有在网页里调用工具；模型能否调用是用 headless 命令行验证的：把 web 文件里的同一个块作为 `--patch` 临时覆盖层（不写进 `headless` profile），中枢在 4317 端口运行，DSH 调用了 `list_members` 和 `ask`（问 OpenCode，中枢记一次唤起），`--approval-policy never` 没有拦截 MCP 工具调用。只跑了一次；`disconnect --apply` 没有在真实配置上试过。
- DSH 启动或热加载时会重写 profile 的 `cordis.patch.yml`：`headless` 的文件在两次 headless 运行后修改时间都变了，用 `cmp` 对比内容逐字节相同；`web` 的文件被开着的 `dsh web` 改了缩进（见上一条）。本仓库里没有代码写 `headless` 的文件（中枢用 `--patch` 从自己的数据目录传模型覆盖）。`dsh --profile … --dump-config` 不会重写。
- Claude Code 的命令行在这台机器上没有登录，涉及 Claude Code 的一切（聊天调用、`--strict-mcp-config` 的隔离效果、`claude mcp add` 的登记、冒烟脚本里新增的 `complete()` 检查）都没有用真实命令行验证过。
- Claude Code 的 MCP 工具超时是否由环境变量 `MCP_TOOL_TIMEOUT` 控制、是否会被遵守，未验证；`connect` 不改它。如果 `ask` 在 Claude Code 里提前超时，需要自己设置这个环境变量。
- OpenCode 的"聊天时看不到 `agent-chat` 工具"用真实命令行测过：把 `agent-chat` 登记在（临时目录里的）全局配置、适配器的 `opencode.json` 放在另一个工作目录，`agentchat` agent 的工具只有 `glob grep read skill webfetch websearch`，要求它调用 `list_members` 时没有发生任何工具调用，而默认 agent 能调用（通过它的 `execute` 工具）。OpenCode 的 MCP 工具不一定出现在模型自述的工具清单里，所以自述清单本身不是可靠证据，冒烟脚本里 OpenCode 的"MCP 隔离"一步实际上是空洞的（默认 agent 也会回答 `NO_MCP_TOOLS`）；可靠的证据是上面这种"要求它真的去调用"的实测。
  这个结论的局限：每种情况只跑了一次；探测用的是 OpenCode 的 `--standalone` 模式加临时全局配置目录，因为 OpenCode 的后台服务会忽略客户端传入的 `XDG_CONFIG_HOME`；后台服务加真实全局登记这种组合后来测过一次（见上面 OpenCode 真实登记那一条）；OpenCode 的模型自述工具清单不可靠（MCP 工具是通过 `execute` 工具调用的），所以决定性的证据是“调用尝试”的结果，而不是自述清单。

## 测试

```bash
npm test                       # 自动测试，不调用真实 agent
npm run smoke -- codex         # 手动冒烟，会调用真实 agent 并产生费用
```

`npm test` 的每个包都挂着同一道防线（`test/guard.ts`）：临时 `HOME`、`XDG_CONFIG_HOME`、`CODEX_HOME`，并在 `PATH` 最前面放 `codex`、`claude`、`opencode`、`dsh`、`security` 的假脚本，任何测试调用到它们，整个测试文件就失败。

`smoke` 可选 `claude`、`codex`、`opencode`、`dsh`。每个 agent 都会依次跑：`complete()` 的三个检查（原始提问、MCP 隔离、工具清单）、会话续接、只读强制。DSH 可用 `DSH_SMOKE_MODEL="provider|model"` 指定模型。
