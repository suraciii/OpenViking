// Session lifecycle: map each dsh session to an OpenViking session, capture
// human user turns, assistant replies, and (optionally) tool executions, and
// commit at turn boundaries and session disposal so the server can extract
// long-term memory.
//
// All writes for one session run through a serialized promise chain so capture
// and commit operations never interleave out of order. Retryable failures are
// enqueued by the shared durable pending queue and replayed on the next boot.
import { createClient } from "./client.mjs";
import { extractTextFromContent } from "./shared/capture-utils.mjs";
import { createLogger } from "./shared/debug-log.mjs";
import { enqueue } from "./shared/pending-queue.mjs";
import { isRetryableFailure } from "./shared/retryable.mjs";

const CAPTURE_BUFFER_LIMIT = 200;
const PREFIX = "dsh";
const DISPOSE_COMMIT_TIMEOUT_MS = 3000;

function safePart(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]/g, "-");
}

function ovSessionIdFor(sessionId) {
  return `${PREFIX}-${safePart(sessionId)}`;
}

function textOf(message, cfg) {
  if (!message || !Array.isArray(message.content)) return "";
  let text = "";
  if (cfg.captureTools) {
    text = extractTextFromContent(message.content, { toolMaxChars: cfg.captureToolMaxChars });
  } else {
    // Without captureTools, keep only plain text blocks: tool calls and their
    // results would otherwise leak noisy internals into long-term memory.
    const textBlocks = message.content.filter((block) => block?.type === "text");
    text = extractTextFromContent(textBlocks, { toolMaxChars: cfg.captureToolMaxChars });
  }
  if (text.length > cfg.captureMaxLength) {
    return text.slice(0, cfg.captureMaxLength);
  }
  return text;
}

function createdAtOf(event) {
  const time = Number(event?.time);
  if (!Number.isFinite(time) || time < 0) return undefined;
  try {
    return new Date(time).toISOString();
  } catch {
    return undefined;
  }
}

function isSubagent(session, cfg) {
  return Boolean(session.header?.parentSession) && !cfg.captureSubagents;
}

/**
 * Create the per-session capture/commit tracker.
 *
 * @param {object} ctx - the plugin's Cordis context (used for disposal and logging).
 * @param {object} cfg - resolved plugin configuration.
 * @returns {object} tracker API.
 */
export function createSessionTracker(ctx, cfg) {
  const logger = createLogger("dsh:session", cfg);
  /** @type {Map<string, object>} keyed by dsh session id. */
  const states = new Map();

  function stateFor(session) {
    const id = String(session.id);
    let state = states.get(id);
    if (!state) {
      const cwd = session.header?.cwd || process.cwd();
      state = {
        sessionId: id,
        ovSessionId: ovSessionIdFor(id),
        cwd,
        client: createClient(cfg, cwd),
        pending: [],
        turnsSinceCommit: 0,
        // Serialized write chain: every capture/commit op appends here.
        writes: Promise.resolve(),
        // callId -> tool name, populated from tool/call events when captureTools.
        toolNames: new Map(),
      };
      states.set(id, state);
    }
    return state;
  }

  /** Append one async write operation to the session's serialized chain. */
  function enqueueWrite(state, operation) {
    state.writes = state.writes.then(operation).catch((error) => {
      logger.log("write_error", { sessionId: state.sessionId, error: String(error?.message || error) });
    });
  }

  async function sendPending(state) {
    if (state.pending.length === 0) return { sent: 0, pendingTokens: 0 };
    const payloads = state.pending;
    state.pending = [];
    const result = await state.client.fetchJSON(
      `/api/v1/sessions/${encodeURIComponent(state.ovSessionId)}/messages/batch`,
      { method: "POST", body: JSON.stringify({ messages: payloads }) },
    );
    if (!result.ok) {
      if (isRetryableFailure(result)) {
        await enqueue("addMessage", state.ovSessionId, { messages: payloads });
      }
      logger.log("flush_failed", { sessionId: state.sessionId, queued: payloads.length, status: result.status });
      return { sent: 0, pendingTokens: 0, retryable: true };
    }
    const pendingTokens = Number(result.result?.pending_tokens ?? 0);
    logger.log("flush", { sessionId: state.sessionId, sent: payloads.length, pendingTokens });
    return { sent: payloads.length, pendingTokens };
  }

  async function commit(state, opts = {}) {
    await sendPending(state);
    // Boundary commits (session disposal) pass keepRecentCount 0 so everything
    // is archived and extracted; routine commits keep the configured window so
    // the newest raw messages stay live, matching the other harness plugins.
    const keepRecentCount = Number.isFinite(opts.keepRecentCount)
      ? Math.max(0, opts.keepRecentCount)
      : cfg.commitKeepRecentCount;
    const result = await state.client.fetchJSON(
      `/api/v1/sessions/${encodeURIComponent(state.ovSessionId)}/commit`,
      {
        method: "POST",
        body: JSON.stringify({ keep_recent_count: keepRecentCount }),
      },
      opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {},
    );
    if (!result.ok && isRetryableFailure(result)) {
      await enqueue("commitSession", state.ovSessionId, { keep_recent_count: keepRecentCount });
    }
    if (result.ok) {
      state.turnsSinceCommit = 0;
    }
    logger.log("commit", { sessionId: state.sessionId, ok: result.ok, status: result.status });
    return result;
  }

  /** Commit when the server-reported pending tokens cross the threshold. */
  async function maybeCommitByToken(state) {
    await sendPending(state);
    const sessionInfo = await state.client.fetchJSON(
      `/api/v1/sessions/${encodeURIComponent(state.ovSessionId)}`,
    );
    const pendingTokens = Number(sessionInfo?.result?.pending_tokens ?? 0);
    if (pendingTokens >= cfg.commitTokenThreshold) {
      await commit(state);
    }
  }

  return {
    stateFor,

    /** Handle one `session/event` firehose event. */
    onSessionEvent(session, event) {
      if (!cfg.enabled || !cfg.autoCapture) return;
      // Subagent sessions (header.parentSession set) are task-scoped workers;
      // capturing them would flood memory with delegated-tool noise. Recall
      // still runs for them; only capture is skipped unless opted in.
      if (isSubagent(session, cfg)) return;
      const state = stateFor(session);

      if (event.type === "tool/call") {
        // Remember tool names by callId so tool/result captures can label them.
        if (cfg.captureTools) {
          state.toolNames.set(String(event.data?.callId), String(event.data?.name || "tool"));
        }
        return;
      }

      if (event.type === "tool/result") {
        const callId = String(event.data?.message?.callId ?? event.data?.callId ?? "");
        if (cfg.captureTools && event.data?.message?.content) {
          const text = textOf(event.data.message, cfg);
          if (text.trim()) {
            state.pending.push({ role: "assistant", content: text });
            if (state.pending.length > CAPTURE_BUFFER_LIMIT) {
              state.pending.splice(0, state.pending.length - CAPTURE_BUFFER_LIMIT);
            }
          }
        }
        if (callId) state.toolNames.delete(callId);
        return;
      }

      switch (event.type) {
        case "user/message": {
          if (event.data.source?.kind !== "user") return;
          const text = textOf(event.data, cfg);
          if (!text.trim()) return;
          const payload = { role: "user", content: text };
          const createdAt = createdAtOf(event);
          if (createdAt) payload.created_at = createdAt;
          if (cfg.peerId) payload.peer_id = cfg.peerId;
          state.pending.push(payload);
          if (state.pending.length > CAPTURE_BUFFER_LIMIT) {
            state.pending.splice(0, state.pending.length - CAPTURE_BUFFER_LIMIT);
          }
          return;
        }
        case "assistant/message": {
          if (cfg.captureAssistantTurns === false) return;
          const text = textOf(event.data.message, cfg);
          if (!text.trim()) return;
          const payload = { role: "assistant", content: text };
          const createdAt = createdAtOf(event);
          if (createdAt) payload.created_at = createdAt;
          if (cfg.peerId) payload.peer_id = cfg.peerId;
          state.pending.push(payload);
          if (state.pending.length > CAPTURE_BUFFER_LIMIT) {
            state.pending.splice(0, state.pending.length - CAPTURE_BUFFER_LIMIT);
          }
          return;
        }
        case "turn/end": {
          state.turnsSinceCommit += 1;
          if (state.turnsSinceCommit >= cfg.commitTurnThreshold) {
            enqueueWrite(state, () => commit(state));
          } else if (cfg.commitTokenThreshold > 0) {
            enqueueWrite(state, () => maybeCommitByToken(state));
          } else {
            enqueueWrite(state, () => sendPending(state));
          }
          return;
        }
        default:
          return;
      }
    },

    /** Flush and commit one session; used on disposal and by /viking commit. */
    async flushAndCommit(session) {
      const state = stateFor(session);
      await commit(state);
      return state.ovSessionId;
    },

    /** Detached best-effort flush+commit at agent disposal (bounded timeout). */
    onAgentDisposed(agent) {
      const session = agent.session;
      if (!session) return;
      if (!cfg.enabled || !cfg.autoCapture) return;
      if (isSubagent(session, cfg)) return;
      const state = stateFor(session);
      const timeoutMs = Math.min(DISPOSE_COMMIT_TIMEOUT_MS, Number(cfg.timeoutMs) || DISPOSE_COMMIT_TIMEOUT_MS);
      enqueueWrite(state, () => commit(state, { timeoutMs, keepRecentCount: 0 }));
      state.writes.finally(() => {
        if (states.get(String(session.id)) === state) states.delete(String(session.id));
      });
    },
  };
}
