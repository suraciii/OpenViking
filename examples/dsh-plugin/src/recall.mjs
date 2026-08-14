// Auto-recall: before each step that admits a real human prompt, retrieve
// relevant OpenViking context and append it as a synthetic notice message so
// the model sees memory for the current turn. The loop logs every message in
// the pre-step `enter` decision, so the injected recall is reconstructable
// from the session log.
//
// The message is built the same way dsh's own createUserMessage does (id +
// role from the pinned peer, frozen before publication) so identity and
// normalization stay consistent with dsh's message invariants.
import { randomUUID } from "node:crypto";

import { recallForPrompt } from "./shared/agent-hook-runtime.mjs";
import { extractTextFromContent } from "./shared/capture-utils.mjs";
import { createLogger } from "./shared/debug-log.mjs";

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/** dsh-equivalent createUserMessage: fresh stable identity, frozen. */
export function createNoticeMessage(content, form) {
  return deepFreeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: content }],
    source: {
      kind: "plugin",
      plugin: "openviking",
      form,
      summary: "openviking recall",
    },
  });
}

/**
 * Install the pre-step recall waterfall.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object} cfg - resolved plugin configuration.
 * @param {object} tracker - session tracker from createSessionTracker.
 */
export function installRecall(ctx, cfg, tracker) {
  const logger = createLogger("dsh:recall", cfg);

  // prepend: downstream waterfall listeners run first, so this plugin sees
  // the final claimed batch and appends after every other contributor.
  ctx.on("agent/pre-step", async ({ agent }, next) => {
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
      const block = await recallForPrompt(
        state.client.fetchJSON,
        cfg,
        text,
        state.cwd,
        (stage, data) => {
          logger.log(stage, data);
          ctx.logger?.debug?.(`openviking recall ${stage}: ${JSON.stringify(data)}`);
        },
        { sessionId: state.ovSessionId, actorPeerId: state.client.effectivePeer.peerId },
      );
      if (!block) return decision;
      return { kind: "enter", messages: [...decision.messages, createNoticeMessage(block, "recall")] };
    } catch (error) {
      logger.log("recall_error", { message: String(error?.message || error) });
      ctx.logger?.warn?.(`openviking recall failed: ${error?.message || error}`);
      return decision;
    }
  }, { prepend: true });
}
