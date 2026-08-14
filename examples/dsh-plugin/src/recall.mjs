// Auto-recall: before each step that admits a real human prompt, retrieve
// relevant OpenViking context and append it as a synthetic notice message so
// the model sees memory for the current turn. The loop logs every message in
// the pre-step `enter` decision, so the injected recall is reconstructable
// from the session log.
import { randomUUID } from "node:crypto";

import { recallForPrompt } from "./shared/agent-hook-runtime.mjs";
import { buildProfileBlock } from "./shared/profile-inject.mjs";
import { extractTextFromContent } from "./shared/capture-utils.mjs";
import { createLogger } from "./shared/debug-log.mjs";

/**
 * Install the pre-step recall waterfall.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object} cfg - resolved plugin configuration.
 * @param {object} tracker - session tracker from createSessionTracker.
 */
export function installRecall(ctx, cfg, tracker) {
  const logger = createLogger("dsh:recall", cfg);
  /** Sessions that already received their one-shot profile block. */
  const profiledSessions = new Set();

  async function profileBlockFor(state) {
    if (!cfg.profileInject || profiledSessions.has(state.sessionId)) return "";
    profiledSessions.add(state.sessionId);
    try {
      const profile = await buildProfileBlock(
        state.client.fetchJSON,
        cfg.profileTokenBudget,
        state.client.effectivePeer.peerId,
      );
      if (!profile?.block) return "";
      return [
        '<openviking-context source="session-start">',
        profile.block,
        "</openviking-context>",
      ].join("\n");
    } catch (error) {
      logger.log("profile_error", { message: String(error?.message || error) });
      return "";
    }
  }

  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    if (!cfg.enabled || !cfg.autoRecall) return decision;
    const human = decision.messages.find((message) => message?.source?.kind === "user");
    if (!human) return decision;
    const text = extractTextFromContent(human.content);
    if (!text?.trim()) return decision;
    if (text.trim().length < cfg.minQueryLength) return decision;
    const session = agent.session;
    if (!session) return decision;
    const state = tracker.stateFor(session);
    try {
      const [block, profile] = await Promise.all([
        recallForPrompt(
          state.client.fetchJSON,
          cfg,
          text,
          state.cwd,
          (stage, data) => {
            logger.log(stage, data);
            ctx.logger?.debug?.(`openviking recall ${stage}: ${JSON.stringify(data)}`);
          },
          { sessionId: state.ovSessionId, actorPeerId: state.client.effectivePeer.peerId },
        ),
        profileBlockFor(state),
      ]);
      const parts = [profile, block].filter(Boolean);
      if (parts.length === 0) return decision;
      const recallMessage = {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: parts.join("\n\n") }],
        source: {
          kind: "plugin",
          plugin: "openviking",
          form: "notice",
          summary: "openviking recall",
        },
      };
      return { kind: "enter", messages: [...decision.messages, recallMessage] };
    } catch (error) {
      logger.log("recall_error", { message: String(error?.message || error) });
      ctx.logger?.warn?.(`openviking recall failed: ${error?.message || error}`);
      return decision;
    }
  });
}
