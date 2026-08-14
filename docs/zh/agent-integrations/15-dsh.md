# DeepSeek Harness (dsh) 插件

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh)接入 OpenViking 上下文数据库作为长期记忆。插件在每个用户回合前注入召回上下文、增量捕获回合,并在提交会话时触发服务端记忆提取。模型工具同时来自原生 `openviking_*` 工具(记忆闭环原语)与 OpenViking 内置 MCP 端点(dsh 的 MCP 客户端接入)。

来源:[examples/dsh-plugin](https://github.com/volcengine/OpenViking/tree/main/examples/dsh-plugin)

## 前置条件

- 组合了 `tools` 与 `systemPrompt` 服务的 dsh 部署(标准 agent-spine 组合)
- 运行中的 OpenViking HTTP 服务(默认 `http://localhost:1933`)
- 服务要求认证时提供 OpenViking API key

## 安装

在 dsh 的 `cordis.yml` 中挂载插件(完整示例:`examples/dsh-plugin/cordis.yml.example`):

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

凭据依次回退到 `OPENVIKING_*` 环境变量与 `~/.openviking/ovcli.conf`,与其他记忆插件一致。

## 功能

- **自动召回** — 在每个包含真实人类消息的 step 开始前,检索相关 OpenViking 上下文并以合成 notice 消息注入,让模型在当前回合看到记忆。召回块写入会话日志(dsh 会记录 pre-step 的每条消息),满足 dsh 的"模型可见 ⟺ 已记录"不变量。可选会话开始时的用户档案注入(`profileInject`)。
- **会话捕获** — 每个 dsh 会话映射到一个 OpenViking 会话(`dsh-<sessionId>`),增量捕获人类用户回合与助手回复;插件来源的注入(召回、goal 轮次、skill 内容)不会被捕获;子代理会话默认跳过(`captureSubagents`)。
- **提交触发记忆提取** — 每个 `turn/end` 冲刷捕获消息,每 `commitTurnThreshold` 个回合及 agent 销毁时提交;可重试失败进入共享的持久化 pending 队列。
- **原生工具** — `openviking_search`、`openviking_find`、`openviking_read`、`openviking_list`、`openviking_remember`、`openviking_commit`、`openviking_health`。
- **viking:// URI 守卫** — 拒绝本地文件系统直接读取 `viking://` URI,并引导模型使用 OpenViking 工具。
- **系统提示词区块** 与 `/viking` 人类命令(查看状态 / 强制提交)。

完整工具面(watch、代码导航、`add_resource` 上传、grep/glob 等)由服务端内置 MCP 端点 + `@deepseek-ai/dsh-mcp-client` 提供。

## 配置

完整字段表见插件 README。关键开关:`autoRecall`、`autoCapture`、`commitTurnThreshold`(默认 8 回合)、`recallLimit`(10)、`scoreThreshold`(0.35)、`timeoutMs`(15000)、`debug`。

## 测试

```bash
cd examples/dsh-plugin && node --test tests/*.test.mjs
```

单元测试通过 stub `globalThis.fetch` 完成,不需要真实 OpenViking 服务。vendored 共享运行时(`src/shared/`)由 `examples/memory-plugin-shared/sync.mjs` 生成。
