// Model-facing OpenViking tools registered on ctx.tools. The full OpenViking
// tool closure (watches, code navigation, add_resource uploads, ...) is served
// by the OpenViking server's MCP endpoint through dsh-mcp-client; these native
// tools own the memory-loop primitives: retrieval, read, list, remember,
// commit, and health.
import { callWithSignal, isRecord } from "./client.mjs";
import { addAgentMessages, commitAgentSession } from "./shared/agent-hook-runtime.mjs";
import { buildServerAssembledBlock } from "./shared/recall-core.mjs";
import { createLogger } from "./shared/debug-log.mjs";

const MAX_RESULT_CHARS = 20000;

function bound(text) {
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated)`;
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

/** Render any tool result as one text block (generic UI intent). */
function render(_args, value) {
  return [{ type: "text", text: textOf(value) }];
}

function stringSchema(description) {
  return { type: "string", description };
}

function numberSchema(description) {
  return { type: "number", description };
}

/**
 * Register the native OpenViking tools.
 *
 * @param {object} ctx - the plugin's Cordis context (requires `tools`).
 * @param {object} cfg - resolved plugin configuration.
 * @param {object} tracker - session tracker from createSessionTracker.
 */
export function installTools(ctx, cfg, tracker) {
  const logger = createLogger("dsh:tools", cfg);
  let rememberCounter = 0;

  function clientFor(exec) {
    const session = exec.agent?.session;
    if (!session) throw new Error("openviking tools require a live agent session");
    return tracker.stateFor(session);
  }

  function register(definition) {
    ctx.tools.register(definition);
  }

  register({
    name: "openviking_search",
    description:
      "Search the OpenViking context database (memories, resources, skills) and return a server-assembled context block for this session.",
    parameters: {
      type: "object",
      properties: {
        query: stringSchema("The search query, phrased as the information you need."),
      },
      required: ["query"],
    },
    output: { schema: { type: "string" }, render },
    async execute(args, exec) {
      const query = String(args.query || "").trim();
      if (!query) return "OpenViking search failed: provide a non-empty query.";
      const state = clientFor(exec);
      const block = await buildServerAssembledBlock(
        state.client.fetchJSON,
        cfg,
        query,
        {
          sessionId: state.ovSessionId,
          actorPeerId: state.client.effectivePeer.peerId,
          log: (stage, data) => logger.log(stage, data),
        },
      );
      if (!block) return "OpenViking search returned no context.";
      return bound(block);
    },
  });

  register({
    name: "openviking_find",
    description:
      "Fast OpenViking semantic retrieval without session context; returns matching resource/memory entries with scores.",
    parameters: {
      type: "object",
      properties: {
        query: stringSchema("The search query."),
        target_uri: stringSchema(
          "Optional viking:// URI limiting the search scope, e.g. viking://resources/my_project/",
        ),
        limit: numberSchema("Maximum number of results (default 10)."),
        min_score: numberSchema("Minimum similarity score (default 0.35)."),
      },
      required: ["query"],
    },
    output: { schema: { type: "string" }, render },
    async execute(args, exec) {
      const state = clientFor(exec);
      const body = { query: String(args.query) };
      if (args.target_uri) body.target_uri = String(args.target_uri);
      if (args.limit !== undefined) body.limit = Number(args.limit);
      if (args.min_score !== undefined) body.min_score = Number(args.min_score);
      const result = await callWithSignal(
        state.client.fetchJSON,
        "/api/v1/search/find",
        { method: "POST", body: JSON.stringify(body) },
        exec.signal,
      );
      if (!result.ok) {
        return `OpenViking find failed (${result.status || "network"}): ${textOf(result.error)}`;
      }
      return bound(textOf(result.result));
    },
  });

  register({
    name: "openviking_read",
    description:
      "Read the content of one viking:// URI (file content; use openviking_list first to discover URIs).",
    parameters: {
      type: "object",
      properties: {
        uri: stringSchema("The viking:// URI to read, e.g. viking://resources/my_project/docs/api.md"),
      },
      required: ["uri"],
    },
    output: { schema: { type: "string" }, render },
    async execute(args, exec) {
      const state = clientFor(exec);
      const result = await callWithSignal(
        state.client.fetchJSON,
        `/api/v1/content/read?uri=${encodeURIComponent(String(args.uri))}`,
        {},
        exec.signal,
      );
      if (!result.ok) {
        return `OpenViking read failed (${result.status || "network"}): ${textOf(result.error)}`;
      }
      const content = isRecord(result.result)
        ? (result.result.content ?? result.result.text ?? textOf(result.result))
        : textOf(result.result);
      return bound(content);
    },
  });

  register({
    name: "openviking_list",
    description:
      "List entries under a viking:// directory, optionally recursive. Use this to discover what OpenViking context exists.",
    parameters: {
      type: "object",
      properties: {
        uri: stringSchema("The viking:// directory to list, e.g. viking://resources/"),
        recursive: { type: "boolean", description: "List recursively (default false)." },
      },
      required: ["uri"],
    },
    output: { schema: { type: "string" }, render },
    async execute(args, exec) {
      const state = clientFor(exec);
      const query = new URLSearchParams({
        uri: String(args.uri),
        output: "original",
      });
      if (args.recursive) query.set("recursive", "true");
      const result = await callWithSignal(
        state.client.fetchJSON,
        `/api/v1/fs/ls?${query.toString()}`,
        {},
        exec.signal,
      );
      if (!result.ok) {
        return `OpenViking list failed (${result.status || "network"}): ${textOf(result.error)}`;
      }
      const entries = Array.isArray(result.result?.entries)
        ? result.result.entries
        : Array.isArray(result.result)
          ? result.result
          : [];
      if (entries.length === 0) return `(empty) ${String(args.uri)}`;
      const lines = entries.map((entry) => {
        const name = entry.name ?? entry.uri ?? "";
        const type = entry.type ?? entry.kind ?? "";
        return type ? `${type.padEnd(8)} ${name}` : name;
      });
      return bound(lines.join("\n"));
    },
  });

  register({
    name: "openviking_remember",
    description:
      "Store user/assistant messages into OpenViking long-term memory in a one-off session and commit, triggering memory extraction. Use when the user states personal preferences, facts, or experience worth remembering.",
    parameters: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          description: "Messages to remember, each {role: user|assistant, content}.",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant"] },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
        },
      },
      required: ["messages"],
    },
    output: { schema: { type: "string" }, render },
    async execute(args, exec) {
      const state = clientFor(exec);
      const payloads = Array.isArray(args.messages)
        ? args.messages.filter(
            (message) =>
              isRecord(message)
              && (message.role === "user" || message.role === "assistant")
              && typeof message.content === "string"
              && message.content.trim(),
          )
        : [];
      if (payloads.length === 0) {
        return "OpenViking remember failed: provide at least one {role, content} message.";
      }
      rememberCounter += 1;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const sessionId = `dsh-remember-${timestamp}-${String(rememberCounter).padStart(4, "0")}`;
      const sent = await callWithSignal(
        state.client.fetchJSON,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/batch`,
        { method: "POST", body: JSON.stringify({ messages: payloads }) },
        exec.signal,
      );
      if (!sent.ok) {
        return `OpenViking remember failed (${sent.status || "network"}): ${textOf(sent.error)}`;
      }
      const committed = await callWithSignal(
        state.client.fetchJSON,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
        { method: "POST", body: "{}" },
        exec.signal,
      );
      if (!committed.ok) {
        return `OpenViking remember: messages stored but commit failed (${committed.status || "network"}): ${textOf(committed.error)}`;
      }
      const archiveUri = committed.result?.archive_uri ?? "";
      return JSON.stringify({
        status: "success",
        session_id: sessionId,
        message_count: payloads.length,
        ...(archiveUri ? { archive_uri: archiveUri } : {}),
      });
    },
  });

  register({
    name: "openviking_commit",
    description:
      "Flush pending captured messages of the current session to OpenViking and commit, triggering memory extraction. Usually automatic; use to force a commit.",
    parameters: { type: "object", properties: {} },
    output: { schema: { type: "string" }, render },
    async execute(_args, exec) {
      const state = clientFor(exec);
      await tracker.flushAndCommit(exec.agent.session);
      return `Committed OpenViking session ${state.ovSessionId}.`;
    },
  });

  register({
    name: "openviking_browse",
    description:
      "Browse the OpenViking store like a filesystem: list a viking:// directory or stat one entry (action=list|stat, uri defaults to viking://).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "stat"], description: "list a directory or stat one entry." },
        uri: stringSchema("viking:// URI (default: viking://)."),
      },
      required: ["action"],
    },
    output: { schema: { type: "string" }, render },
    async execute(args, exec) {
      const state = clientFor(exec);
      const uri = String(args.uri || "viking://");
      if (args.action === "stat") {
        const info = await callWithSignal(
          state.client.fetchJSON,
          `/api/v1/fs/stat?uri=${encodeURIComponent(uri)}`,
          {},
          exec.signal,
        );
        if (!info.ok) return `OpenViking stat failed: not found or unreadable (${uri}).`;
        return bound(textOf(info.result));
      }
      const result = await callWithSignal(
        state.client.fetchJSON,
        `/api/v1/fs/ls?uri=${encodeURIComponent(uri)}&output=original`,
        {},
        exec.signal,
      );
      if (!result.ok) return `OpenViking browse failed (${result.status || "network"}): ${textOf(result.error)}`;
      const entries = Array.isArray(result.result?.entries)
        ? result.result.entries
        : Array.isArray(result.result)
          ? result.result
          : [];
      if (entries.length === 0) return `(empty) ${uri}`;
      return bound(entries.map((entry) => {
        const name = entry.name ?? entry.uri ?? "";
        return entry.isDir ? `📁 ${name}` : `📄 ${name}`;
      }).join("\n"));
    },
  });

  register({
    name: "openviking_forget",
    description:
      "Delete a memory by viking:// URI, or remove the strongest search match (score above min_score, default 0.8). Use to correct outdated or wrong information.",
    parameters: {
      type: "object",
      properties: {
        uri: stringSchema("Exact viking:// URI of the memory to delete."),
        query: stringSchema("Search query; deletes the strongest match when its score exceeds min_score."),
        min_score: numberSchema("Minimum score for query deletion (default 0.8)."),
      },
      required: [],
    },
    output: { schema: { type: "string" }, render },
    async execute(args, exec) {
      const state = clientFor(exec);
      if (args.uri) {
        const ok = await callWithSignal(
          state.client.fetchJSON,
          `/api/v1/fs?uri=${encodeURIComponent(String(args.uri))}&recursive=false`,
          { method: "DELETE" },
          exec.signal,
        );
        return ok.ok
          ? `Deleted: ${args.uri}`
          : `OpenViking forget failed (${ok.status || "network"}): ${textOf(ok.error)}`;
      }
      if (args.query) {
        const minScore = Number(args.min_score ?? 0.8);
        const found = await callWithSignal(
          state.client.fetchJSON,
          "/api/v1/search/find",
          { method: "POST", body: JSON.stringify({ query: String(args.query), limit: 1 }) },
          exec.signal,
        );
        const hit = Array.isArray(found.result?.entries) ? found.result.entries[0]
          : Array.isArray(found.result) ? found.result[0] : null;
        if (hit && Number(hit.score ?? 0) >= minScore) {
          const ok = await callWithSignal(
            state.client.fetchJSON,
            `/api/v1/fs?uri=${encodeURIComponent(String(hit.uri))}&recursive=false`,
            { method: "DELETE" },
            exec.signal,
          );
          return ok.ok ? `Deleted: ${hit.uri} (score ${Number(hit.score).toFixed(2)})` : `Failed to delete: ${hit.uri}`;
        }
        return `No strong match found (score >= ${minScore} required).`;
      }
      return "OpenViking forget: provide either 'uri' or 'query'.";
    },
  });

  register({
    name: "openviking_add_resource",
    description:
      "Ingest a remote URL into OpenViking; the page is processed into tiered content and indexed for semantic search. HTTP(S) URLs only — the server rejects direct host filesystem paths.",
    parameters: {
      type: "object",
      properties: {
        path: stringSchema("The HTTP(S) URL to ingest."),
        to: stringSchema("Optional target viking:// directory."),
      },
      required: ["path"],
    },
    output: { schema: { type: "string" }, render },
    async execute(args, exec) {
      const state = clientFor(exec);
      const body = { path: String(args.path) };
      if (args.to) body.to = String(args.to);
      const result = await callWithSignal(
        state.client.fetchJSON,
        "/api/v1/resources",
        { method: "POST", body: JSON.stringify(body) },
        exec.signal,
      );
      if (!result.ok) {
        return `OpenViking add_resource failed (${result.status || "network"}): ${textOf(result.error)}`;
      }
      const rootUri = isRecord(result.result) ? result.result.root_uri : "";
      return rootUri ? `Ingested: ${rootUri}` : `Ingested: ${args.path}`;
    },
  });

  register({
    name: "openviking_archive_expand",
    description:
      "Expand an archived OpenViking session into its overview (raw messages summarized by the server). Use when an archive summary is too coarse and you need detailed history.",
    parameters: {
      type: "object",
      properties: {
        session_id: stringSchema("The OpenViking session id (e.g. dsh-<dsh session id>)."),
      },
      required: ["session_id"],
    },
    output: { schema: { type: "string" }, render },
    async execute(args, exec) {
      const state = clientFor(exec);
      const sid = String(args.session_id);
      const base = `viking://session/${encodeURIComponent(sid)}`;
      for (const uri of [base, `${base}/history`]) {
        const result = await callWithSignal(
          state.client.fetchJSON,
          `/api/v1/content/overview?uri=${encodeURIComponent(uri)}`,
          {},
          exec.signal,
        );
        if (result.ok) return bound(textOf(result.result));
      }
      return `OpenViking archive not found: ${sid}`;
    },
  });

  register({
    name: "openviking_health",
    description: "Check whether the OpenViking server is reachable and healthy.",
    parameters: { type: "object", properties: {} },
    output: { schema: { type: "string" }, render },
    async execute(_args, exec) {
      const state = clientFor(exec);
      const result = await callWithSignal(
        state.client.fetchJSON,
        "/api/v1/system/status",
        {},
        exec.signal,
      );
      if (!result.ok) {
        return `OpenViking unhealthy (${result.status || "network"}): ${textOf(result.error)}`;
      }
      return `OpenViking healthy (${state.client.effectivePeer.peerId || "no peer"}).`;
    },
  });
}
