// REST client wrapper around the shared OpenViking runtime. One client per
// dsh session (cached by session id) so the workspace-derived actor peer
// stays stable for that session's lifetime.
import { makeAgentFetchJSON } from "./shared/agent-hook-runtime.mjs";

/**
 * Create an OpenViking REST client bound to one session's working directory.
 *
 * @param {object} cfg - resolved plugin configuration.
 * @param {string} cwd - session working directory used for workspace-peer derivation.
 * @returns {{ fetchJSON: Function, effectivePeer: { peerId: string, source: string } }}
 */
export function createClient(cfg, cwd) {
  return makeAgentFetchJSON(cfg, cwd || process.cwd());
}

/** GET /api/v1/sessions/{id}/context?token_budget= — archive overview for a resumed session, when one exists. */
export async function sessionContext(client, sessionId, tokenBudget) {
  const result = await client.fetchJSON(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/context?token_budget=${Number(tokenBudget) || 128000}`,
  );
  return result.ok ? result.result : null;
}

/**
 * Race a shared-runtime request against an external abort signal so tool
 * executions honor `exec.signal`. The underlying request still settles under
 * its own `timeoutMs`; the caller's promise settles on the signal.
 *
 * @param {Function} fetchJSON - (path, init) => Promise<{ ok, status, result?, error? }>
 * @param {string} path - API path.
 * @param {object} init - fetch init.
 * @param {AbortSignal|undefined} signal - external cancellation signal.
 * @returns {Promise<object>} the fetchJSON result envelope.
 */
export async function callWithSignal(fetchJSON, path, init, signal) {
  if (!signal || signal.aborted) {
    if (signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return fetchJSON(path, init);
  }
  let remove = () => {};
  const aborted = new Promise((_, reject) => {
    const onAbort = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([fetchJSON(path, init), aborted]);
  } finally {
    remove();
  }
}

/** True when the value is a JSON-serializable object (not null, not array). */
export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
