// viking:// URI guard: deny direct local filesystem reads of viking:// URIs
// and point the model back to the OpenViking tools, so context is always read
// through OpenViking (tiered loading, retrieval trajectories).
import { evaluateAgentUriGuard } from "./shared/agent-uri-guard.mjs";

/**
 * Install the tools/pre-execute denial gate.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object} cfg - resolved plugin configuration.
 */
export function installUriGuard(ctx, cfg) {
  if (cfg.uriGuard === false) return;
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (!cfg.enabled) return next();
    const hit = evaluateAgentUriGuard(exec.name, exec.arguments);
    if (!hit) return next();
    return { kind: "deny", reason: hit.reason };
  });
}
