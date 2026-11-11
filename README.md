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
