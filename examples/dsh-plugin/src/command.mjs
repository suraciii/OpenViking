// /viking human command: view OpenViking status and force a session commit.
// Registered only when a command registry is composed (web/CLI deployments).
import { createLogger } from "./shared/debug-log.mjs";

/**
 * Register the /viking command on the command registry when one is composed.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object} cfg - resolved plugin configuration.
 * @param {object} tracker - session tracker from createSessionTracker.
 */
export function installCommand(ctx, cfg, tracker) {
  const logger = createLogger("dsh:command", cfg);
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "viking",
      description: "OpenViking status and session commit",
      input: { hint: "[commit|status]" },
      handler: async ({ agent, rawInput }) => {
        const action = rawInput.trim();
        const session = agent.session;
        if (!session) {
          return { kind: "error", text: "OpenViking: no live session." };
        }
        const state = tracker.stateFor(session);
        if (action === "commit") {
          try {
            await tracker.flushAndCommit(session);
            return {
              kind: "success",
              text: `Committed OpenViking session ${state.ovSessionId}.`,
            };
          } catch (error) {
            logger.log("commit_error", { message: String(error?.message || error) });
            return {
              kind: "error",
              text: `OpenViking commit failed: ${error?.message || error}`,
            };
          }
        }
        const pending = state.pending.length;
        return {
          kind: "success",
          text: `OpenViking session ${state.ovSessionId} (${cfg.baseUrl}), pending ${pending} message(s), autoCapture ${cfg.autoCapture ? "on" : "off"}. Usage: /viking commit`,
        };
      },
    });
  });
}
