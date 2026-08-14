// OpenViking plugin for DeepSeek Harness (dsh): long-term memory over the
// OpenViking context database.
//
// Composition (cordis.yml):
//   - id: openviking
//     name: '<path>/examples/dsh-plugin/src/index.mjs'
//     config:
//       baseUrl: http://localhost:1933
//       apiKey: !!js process.env.OPENVIKING_API_KEY
//
// Mount this plugin alongside '@deepseek-ai/dsh-mcp-client' for the full
// OpenViking tool closure (MCP tools) plus the memory loop below.
import { resolveDshConfig } from "./config.mjs";
import { createClient } from "./client.mjs";
import { createSessionTracker } from "./session.mjs";
import { installRecall, createNoticeMessage } from "./recall.mjs";
import { installTools } from "./tools.mjs";
import { installUriGuard } from "./uri-guard.mjs";
import { installPromptSection } from "./prompt.mjs";
import { installCommand } from "./command.mjs";
import { buildProfileBlock } from "./shared/profile-inject.mjs";
import { replayAgentPending } from "./shared/agent-hook-runtime.mjs";
import { sessionContext } from "./client.mjs";
import { createLogger } from "./shared/debug-log.mjs";

export const name = "openviking";
export const inject = ["tools", "systemPrompt"];

export function apply(ctx, config) {
  const cfg = resolveDshConfig(config || {});
  if (!cfg.enabled) return;
  const logger = createLogger("dsh:index", cfg);

  const tracker = createSessionTracker(ctx, cfg);

  // Replay durable pending writes from a previous process before anything new
  // lands, so offline captures eventually reach the server.
  {
    const replayClient = createClient(cfg, process.cwd());
    void replayAgentPending(
      replayClient.fetchJSON,
      (stage, data) => logger.log(stage, data),
    ).catch((error) => logger.log("replay_error", { message: String(error?.message || error) }));
  }

  // One-shot session-start injection: profile (+ optional archive overview)
  // land through dsh's own inbox so the model sees them before the first turn.
  ctx.on("agent/session-start", async ({ agent }) => {
    const session = agent.session;
    if (!session) return;
    const state = tracker.stateFor(session);
    try {
      const parts = [];
      if (cfg.profileInject) {
        const profile = await buildProfileBlock(
          state.client.fetchJSON,
          cfg.profileTokenBudget,
          state.client.effectivePeer.peerId,
        );
        if (profile?.block) {
          parts.push([
            '<openviking-context source="profile">',
            profile.block,
            "</openviking-context>",
          ].join("\n"));
        }
      }
      if (cfg.resumeContextBudget > 0) {
        const resumable = await sessionContext(
          state.client.fetchJSON,
          state.ovSessionId,
          cfg.resumeContextBudget,
        );
        if (resumable?.latest_archive_overview) {
          parts.push([
            '<openviking-context source="session-archive">',
            "<session-archive>",
            resumable.latest_archive_overview,
            "</session-archive>",
            "</openviking-context>",
          ].join("\n"));
        }
      }
      if (parts.length === 0) return;
      if (agent.status !== "idle") return;
      agent.inject(createNoticeMessage(parts.join("\n\n"), "instructions"));
    } catch (error) {
      logger.log("session_start_error", { sessionId: state.sessionId, message: String(error?.message || error) });
    }
  });

  // Session events fire on the shared context regardless of plugin scope.
  ctx.on("session/event", (session, event) => {
    tracker.onSessionEvent(session, event);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    tracker.onAgentDisposed(agent);
  });

  installTools(ctx, cfg, tracker);
  installRecall(ctx, cfg, tracker);
  installUriGuard(ctx, cfg);
  installPromptSection(ctx);
  installCommand(ctx, cfg, tracker);
}
