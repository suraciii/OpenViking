# OpenViking Memory Plugin for DeepSeek Harness (dsh)

A dsh (DeepSeek Harness) plugin that turns OpenViking into the long-term memory
and context backend for a dsh session. It reuses the shared
`memory-plugin-shared` runtime — no memory logic is duplicated. Only a thin
dsh adapter is new.

## What it does

- **Auto-recall** — before each step that admits a real human prompt, retrieves
  relevant OpenViking context and injects it as a synthetic notice message, so
  the model sees memory for the current turn. The recall block is part of the
  session log (the loop records every pre-step message), satisfying dsh's
  model-visible ⟺ logged invariant.
- **Session capture** — maps each dsh session to an OpenViking session
  (`dsh-<sessionId>`) and incrementally captures human user turns and assistant
  replies. Plugin-sourced injections (recalls, goal rounds, skill content) are
  not captured.
- **Commit for memory extraction** — flushes captured turns at every `turn/end`
  and commits (server-side memory extraction) every `commitTurnThreshold` turns
  and at agent disposal. Retryable failures go through the shared durable
  pending queue.
- **Native tools** — `openviking_search`, `openviking_find`, `openviking_read`,
  `openviking_list`, `openviking_remember`, `openviking_commit`, and
  `openviking_health` registered on `ctx.tools`.
- **viking:// URI guard** — denies local filesystem reads of `viking://` URIs
  and points the model back to the OpenViking tools.
- **System-prompt section** — teaches the model about the OpenViking context
  database available in the session.
- **/viking command** — human command to view status and force a commit
  (registered only when a command registry is composed).

The full OpenViking tool closure (watches, code navigation, `add_resource`
uploads, grep/glob, ...) is served by the OpenViking server's built-in MCP
endpoint through `@deepseek-ai/dsh-mcp-client` — see the composition example
below.

## Requirements

- An OpenViking server (`openviking-server`, default `http://localhost:1933`).
  See the [Quickstart](https://docs.openviking.ai/en/getting-started/02-quickstart).
- A dsh deployment that composes the `tools` and `systemPrompt` services
  (the standard agent-spine composition).

## Install

Mount the plugin from this checkout or install it as an npm package. Add to
your dsh `cordis.yml` (full example: [`cordis.yml.example`](./cordis.yml.example)):

```yaml
- id: openviking
  name: '<REPO_ROOT>/examples/dsh-plugin/src/index.mjs'
  config:
    baseUrl: !!js 'process.env.OPENVIKING_URL || "http://localhost:1933"'
    apiKey: !!js process.env.OPENVIKING_API_KEY

# Optional: full OpenViking tool closure via the server's MCP endpoint.
- id: openviking-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: openviking
    transport: streamable-http
    url: !!js '`${process.env.OPENVIKING_URL || "http://localhost:1933"}/mcp`'
    headers:
      Authorization: !!js '`Bearer ${process.env.OPENVIKING_API_KEY || ""}`'
```

All config fields are optional; credentials fall back to the `OPENVIKING_*`
environment variables and then `~/.openviking/ovcli.conf`, exactly like the
other memory plugins.

## Configuration

| Field | Default | Description |
|---|---|---|
| `baseUrl` | env / ovcli.conf | OpenViking server URL |
| `apiKey` | env / ovcli.conf | API key (`X-Api-Key` / Bearer) |
| `account` / `user` | env / ovcli.conf | Multi-tenant identity headers |
| `peerId` | derived from session cwd | Actor peer id (workspace isolation) |
| `enabled` | `true` | Master switch (`OPENVIKING_MEMORY_ENABLED`) |
| `autoRecall` | `true` | Inject recall before each user turn (`OPENVIKING_AUTO_RECALL`) |
| `autoCapture` | `true` | Capture turns into OpenViking (`OPENVIKING_AUTO_CAPTURE`) |
| `commitTurnThreshold` | `8` | Commit (memory extraction) every N turns (`OPENVIKING_COMMIT_TURN_THRESHOLD`) |
| `recallLimit` | `10` | Max recall entries (`OPENVIKING_RECALL_LIMIT`) |
| `recallTokenBudget` | `2000` | Recall token budget (`OPENVIKING_RECALL_TOKEN_BUDGET`) |
| `scoreThreshold` | `0.35` | Minimum similarity score (`OPENVIKING_SCORE_THRESHOLD`) |
| `recallPeerScope` | `all` | `actor` for workspace-isolated recall (`OPENVIKING_RECALL_PEER_SCOPE`) |
| `timeoutMs` | `15000` | Per-request timeout (`OPENVIKING_TIMEOUT_MS`) |
| `uriGuard` | `true` | Deny local reads of `viking://` URIs |
| `debug` | `false` | Structured debug log (`OPENVIKING_DEBUG`) |

## How it works

```text
dsh session ── session/event (user/message, assistant/message)
      │             │ turn/end ──► flush ──► POST /api/v1/sessions/{id}/messages/batch
      │             │ every N turns / agent/disposed ──► commit ──► POST .../commit (memory extraction)
      ▼
agent/pre-step (human prompt) ──► recall ──► POST /api/v1/search/search (context face)
      │                                             │ fallback: /api/v1/search/recall
      ▼
enter decision + recall notice message ──► model request (logged as user/message)
```

- Recall and capture are fail-open: on any error the turn proceeds unchanged
  and the error is logged (debug log or `ctx.logger`).
- The recall block is appended to the step's messages, so it is recorded in
  the session log and reconstructable on replay.
- Offline resilience: retryable send/commit failures are enqueued by the
  shared runtime and replayed later.

## Tests

```bash
node --test tests/*.test.mjs
```

Unit tests stub `globalThis.fetch`; no OpenViking server is required. The
vendored shared runtime (`src/shared/`) is generated by
`examples/memory-plugin-shared/sync.mjs` — never edit those files directly.
