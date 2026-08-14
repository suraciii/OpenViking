// Session lifecycle: map each dsh session to an OpenViking session, capture
// human user turns and assistant replies incrementally, and commit at turn
// boundaries and session disposal so the server can extract long-term memory.
import { createClient } from "./client.mjs";
import { addAgentMessages, commitAgentSession } from "./shared/agent-hook-runtime.mjs";
import { extractTextFromContent } from "./shared/capture-utils.mjs";
import { createLogger } from "./shared/debug-log.mjs";

const CAPTURE_BUFFER_LIMIT = 200;
const PREFIX = "dsh";

function safePart(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]/g, "-");
}

function ovSessionIdFor(sessionId) {
  return `${PREFIX}-${safePart(sessionId)}`;
}

function textOf(message, cfg) {
  if (!message || !Array.isArray(message.content)) return "";
  if (cfg.captureTools) {
    return extractTextFromContent(message.content, { toolMaxChars: cfg.captureToolMaxChars });
  }
  // Without captureTools, keep only plain text blocks: tool calls and their
  // results would otherwise leak noisy internals into long-term memory.
  const textBlocks = message.content.filter((block) => block?.type === "text");
  return extractTextFromContent(textBlocks, { toolMaxChars: cfg.captureToolMaxChars });
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
      };
      states.set(id, state);
    }
    return state;
  }

  async function flush(state) {
    if (!cfg.autoCapture || state.pending.length === 0) return null;
    const payloads = state.pending;
    state.pending = [];
    const result = await addAgentMessages(state.client.fetchJSON, state.ovSessionId, payloads);
    const sent = Number(result?.sent ?? 0);
    if (sent === 0) {
      logger.log("flush_failed", { sessionId: state.sessionId, queued: payloads.length, result });
      return null;
    }
    // Server-reported pending tokens drive the token-threshold commit.
    const pendingTokens = Number(result?.result?.pending_tokens ?? 0);
    logger.log("flush", { sessionId: state.sessionId, sent, pendingTokens });
    return { sent, pendingTokens };
  }

  async function commit(state) {
    await flush(state);
    const result = await commitAgentSession(state.client.fetchJSON, state.ovSessionId);
    if (result?.ok) {
      state.turnsSinceCommit = 0;
    }
    logger.log("commit", { sessionId: state.sessionId, ok: result?.ok, status: result?.status });
  }

  /** Commit when the server-reported pending tokens cross the threshold. */
  async function maybeCommitByToken(state) {
    await flush(state);
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
      if (session.header?.parentSession && !cfg.captureSubagents) return;
      const state = stateFor(session);
      switch (event.type) {
        case "user/message": {
          if (event.data.source?.kind !== "user") return;
          const text = textOf(event.data, cfg);
          if (!text.trim()) return;
          state.pending.push({ role: "user", content: text });
          if (state.pending.length > CAPTURE_BUFFER_LIMIT) {
            state.pending.splice(0, state.pending.length - CAPTURE_BUFFER_LIMIT);
          }
          return;
        }
        case "assistant/message": {
          const text = textOf(event.data.message, cfg);
          if (!text.trim()) return;
          state.pending.push({ role: "assistant", content: text });
          if (state.pending.length > CAPTURE_BUFFER_LIMIT) {
            state.pending.splice(0, state.pending.length - CAPTURE_BUFFER_LIMIT);
          }
          return;
        }
        case "turn/end": {
          state.turnsSinceCommit += 1;
          if (state.turnsSinceCommit >= cfg.commitTurnThreshold) {
            void commit(state).catch(() => {});
          } else if (cfg.commitTokenThreshold > 0) {
            void maybeCommitByToken(state).catch(() => {});
          } else {
            void flush(state).catch(() => {});
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

    /** Detached best-effort flush+commit at agent disposal. */
    onAgentDisposed(agent) {
      const session = agent.session;
      if (!session) return;
      if (!cfg.enabled || !cfg.autoCapture) return;
      if (session.header?.parentSession && !cfg.captureSubagents) return;
      const state = stateFor(session);
      void commit(state).catch(() => {});
      states.delete(String(session.id));
    },
  };
}
