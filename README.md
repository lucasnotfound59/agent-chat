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

中枢会在自己的 OpenCode 工作目录内创建 `opencode.json`（定义只读 agent），不会改动你自己的 OpenCode 配置。

启动时会打印每个 agent 是否可用及原因。

## 设置

设置通过 `PUT /api/config` 写入：

- `triage`：群聊里决定谁发言的小模型，任意 OpenAI 兼容接口，`{ baseUrl, apiKey, model }`。不配置时，群里只有被 @ 的 agent 会回复。
- `dsh`：DSH 使用的模型，`{ provider, model }`。

## 在有界面之前怎么用

每个请求都要带请求头 `Authorization: Bearer <token>`。令牌保存在数据目录的 `config.json` 里，文件只有当前用户可读，不要分享给别人。请求只能发往 `127.0.0.1` 或 `localhost`，其他主机名会被拒绝。

下面的示例用 shell 变量保存令牌，不会把它打印出来（默认数据目录和端口，改过的话请对应修改；需要 `jq`）：

```bash
DATA="$HOME/Library/Application Support/AgentChat"
BASE=http://127.0.0.1:4317
TOKEN=$(jq -r .token "$DATA/config.json")
```

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

## 测试

```bash
npm test                       # 自动测试，不调用真实 agent
npm run smoke -- codex         # 手动冒烟，会调用真实 agent 并产生费用
```

`smoke` 可选 `claude`、`codex`、`opencode`、`dsh`。DSH 可用 `DSH_SMOKE_MODEL="provider|model"` 指定模型。
