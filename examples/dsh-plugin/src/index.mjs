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
import { createSessionTracker } from "./session.mjs";
import { installRecall } from "./recall.mjs";
import { installTools } from "./tools.mjs";
import { installUriGuard } from "./uri-guard.mjs";
import { installPromptSection } from "./prompt.mjs";
import { installCommand } from "./command.mjs";

export const name = "openviking";
export const inject = ["tools", "systemPrompt"];

export function apply(ctx) {
  const cfg = resolveDshConfig(ctx.config || {});
  if (!cfg.enabled) return;

  const tracker = createSessionTracker(ctx, cfg);

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
