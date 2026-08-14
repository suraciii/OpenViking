# OpenViking Memory Plugin for DeepSeek Harness (dsh)

面向 dsh(DeepSeek Harness)的 OpenViking 记忆插件:把 OpenViking 变成 dsh 会话的长期记忆与上下文后端。插件复用共享的 `memory-plugin-shared` 运行时,只新增一层薄薄的 dsh 适配,不重复实现记忆逻辑。

## 功能

- **自动召回(auto-recall)** — 在每个包含真实人类消息的 step 开始前,检索相关 OpenViking 上下文并以合成 notice 消息注入,让模型在当前回合看到记忆。召回块会进入会话日志(loop 会记录 pre-step 的每条消息),满足 dsh 的"模型可见 ⟺ 已记录"不变量。
- **会话捕获(session capture)** — 每个 dsh 会话映射到一个 OpenViking 会话(`dsh-<sessionId>`),增量捕获人类用户回合与助手回复;插件来源的注入(召回、goal 轮次、skill 内容)不会被捕获。
- **提交触发记忆提取(commit)** — 每个 `turn/end` 冲刷捕获消息,每 `commitTurnThreshold` 个回合及 agent 销毁时提交(触发服务端记忆提取);可重试失败进入共享的持久化 pending 队列。
- **原生工具** — 在 `ctx.tools` 注册 `openviking_search`、`openviking_find`、`openviking_read`、`openviking_list`、`openviking_remember`、`openviking_commit`、`openviking_health`。
- **viking:// URI 守卫** — 拒绝本地文件系统直接读取 `viking://` URI,并引导模型使用 OpenViking 工具。
- **系统提示词区块** — 告知模型会话可用的 OpenViking 上下文数据库。
- **/viking 命令** — 人类命令,查看状态与强制提交(仅在组合了命令注册表时注册)。

完整工具面(watch、代码导航、`add_resource` 上传、grep/glob 等)由 OpenViking 服务端内置 MCP 端点 + `@deepseek-ai/dsh-mcp-client` 提供,见下方组合示例。

## 依赖

- 运行中的 OpenViking 服务(`openviking-server`,默认 `http://localhost:1933`),见 [Quickstart](https://docs.openviking.ai/en/getting-started/02-quickstart)。
- 组合了 `tools` 与 `systemPrompt` 服务的 dsh 部署(标准 agent-spine 组合)。

## 安装

从本仓库挂载,或作为 npm 包安装。在你的 dsh `cordis.yml` 中加入(完整示例见 [`cordis.yml.example`](./cordis.yml.example)):

```yaml
- id: openviking
  name: '<REPO_ROOT>/examples/dsh-plugin/src/index.mjs'
  config:
    baseUrl: !!js 'process.env.OPENVIKING_URL || "http://localhost:1933"'
    apiKey: !!js process.env.OPENVIKING_API_KEY

# 可选:通过服务端 MCP 端点获得完整 OpenViking 工具面。
- id: openviking-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: openviking
    transport: streamable-http
    url: !!js '`${process.env.OPENVIKING_URL || "http://localhost:1933"}/mcp`'
    headers:
      Authorization: !!js '`Bearer ${process.env.OPENVIKING_API_KEY || ""}`'
```

所有配置字段均可选;凭据依次回退到 `OPENVIKING_*` 环境变量与 `~/.openviking/ovcli.conf`,与其他记忆插件一致。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | 环境变量 / ovcli.conf | OpenViking 服务地址 |
| `apiKey` | 环境变量 / ovcli.conf | API 密钥(`X-Api-Key` / Bearer) |
| `account` / `user` | 环境变量 / ovcli.conf | 多租户身份头 |
| `peerId` | 由会话 cwd 推导 | actor peer id(工作区隔离) |
| `enabled` | `true` | 总开关(`OPENVIKING_MEMORY_ENABLED`) |
| `autoRecall` | `true` | 每个用户回合前注入召回(`OPENVIKING_AUTO_RECALL`) |
| `autoCapture` | `true` | 捕获回合到 OpenViking(`OPENVIKING_AUTO_CAPTURE`) |
| `commitTurnThreshold` | `8` | 每 N 个回合提交(触发记忆提取)(`OPENVIKING_COMMIT_TURN_THRESHOLD`) |
| `recallLimit` | `10` | 召回条数上限(`OPENVIKING_RECALL_LIMIT`) |
| `recallTokenBudget` | `2000` | 召回 token 预算(`OPENVIKING_RECALL_TOKEN_BUDGET`) |
| `scoreThreshold` | `0.35` | 最低相似度(`OPENVIKING_SCORE_THRESHOLD`) |
| `recallPeerScope` | `all` | `actor` 表示工作区隔离召回(`OPENVIKING_RECALL_PEER_SCOPE`) |
| `recallQueryExpansion` | `auto` | `off` 关闭服务端查询扩展的模型调用(`OPENVIKING_RECALL_QUERY_EXPANSION`) |
| `minQueryLength` | `3` | 更短的人类消息跳过召回(`OPENVIKING_RECALL_MIN_QUERY_LENGTH`) |
| `profileInject` | `false` | 会话开始时注入一次性用户档案块(`OPENVIKING_PROFILE_INJECT`) |
| `profileTokenBudget` | `4000` | 注入档案的 token 预算(`OPENVIKING_PROFILE_TOKEN_BUDGET`) |
| `captureSubagents` | `false` | 同时捕获子代理会话;默认关闭以避免委派任务噪音(`OPENVIKING_CAPTURE_SUBAGENTS`) |
| `captureTools` | `false` | 捕获回合中包含工具调用/结果文本(`OPENVIKING_CAPTURE_TOOLS`) |
| `captureToolMaxChars` | `2000` | `captureTools` 开启时单个工具的截断长度(`OPENVIKING_CAPTURE_TOOL_MAX_CHARS`) |
| `timeoutMs` | `15000` | 单请求超时(`OPENVIKING_TIMEOUT_MS`) |
| `uriGuard` | `true` | 拒绝本地读取 `viking://` URI |
| `debug` | `false` | 结构化调试日志(`OPENVIKING_DEBUG`) |

## 工作原理

```text
dsh 会话 ── session/event (user/message, assistant/message)
      │             │ turn/end ──► 冲刷 ──► POST /api/v1/sessions/{id}/messages/batch
      │             │ 每 N 个回合 / agent 销毁 ──► 提交 ──► POST .../commit (记忆提取)
      ▼
agent/pre-step(人类消息)──► 召回 ──► POST /api/v1/search/search(context face)
      │                                    │ 回退: /api/v1/search/recall
      ▼
enter 决策 + 召回 notice 消息 ──► 模型请求(以 user/message 记录)
```

- 召回与捕获都是 fail-open:任何错误都不阻断回合,错误仅记入日志(调试日志或 `ctx.logger`)。
- 召回块追加进 step 消息,因此会写入会话日志,回放可重建。
- 离线韧性:可重试的发送/提交失败由共享运行时入队,之后重放。

## 测试

```bash
node --test tests/*.test.mjs
```

单元测试通过 stub `globalThis.fetch` 完成,不需要真实 OpenViking 服务。vendored 共享运行时(`src/shared/`)由 `examples/memory-plugin-shared/sync.mjs` 生成——不要直接编辑这些文件。
