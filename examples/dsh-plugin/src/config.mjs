// dsh plugin configuration: plugin config from cordis.yml wins, then
// OPENVIKING_* environment variables, then ovcli.conf / ov.conf credentials.
import { homedir } from "node:os";
import { join } from "node:path";

import { buildUserAgent, resolveOpenVikingCredentials } from "./shared/credentials.mjs";

function bool(value, fallback) {
  if (value == null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function num(value, fallback, minimum = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

/**
 * Resolve the effective plugin configuration.
 *
 * @param {object} pluginConfig - the `config:` block from cordis.yml.
 * @returns {object} config consumed by the shared OpenViking runtime modules.
 */
export function resolveDshConfig(pluginConfig = {}) {
  const env = process.env;
  const credentials = resolveOpenVikingCredentials(env);
  // `endpoint` is the field name used by the pi extension; accept it as an
  // alias for `baseUrl` so the two plugins share one configuration vocabulary.
  const baseUrl = pluginConfig.baseUrl
    || pluginConfig.endpoint
    || credentials.baseUrl;
  const cfg = {
    ...credentials,
    ...pluginConfig,
    baseUrl,
    userAgent: buildUserAgent("dsh", env.OPENVIKING_INTEGRATION_VERSION),
    enabled: bool(env.OPENVIKING_MEMORY_ENABLED, pluginConfig.enabled ?? true),
    autoRecall: bool(env.OPENVIKING_AUTO_RECALL, pluginConfig.autoRecall ?? true),
    autoCapture: bool(env.OPENVIKING_AUTO_CAPTURE, pluginConfig.autoCapture ?? true),
    workspacePeer: bool(env.OPENVIKING_WORKSPACE_PEER, pluginConfig.workspacePeer ?? true),
    recallLimit: num(env.OPENVIKING_RECALL_LIMIT, pluginConfig.recallLimit ?? 10, 1),
    recallTokenBudget: num(
      env.OPENVIKING_RECALL_TOKEN_BUDGET,
      pluginConfig.recallTokenBudget ?? 2000,
      200,
    ),
    recallMaxContentChars: num(
      env.OPENVIKING_RECALL_MAX_CONTENT_CHARS,
      pluginConfig.recallMaxContentChars ?? 500,
      50,
    ),
    scoreThreshold: num(env.OPENVIKING_SCORE_THRESHOLD, pluginConfig.scoreThreshold ?? 0.35, 0),
    recallPreferAbstract: bool(
      env.OPENVIKING_RECALL_PREFER_ABSTRACT,
      pluginConfig.recallPreferAbstract ?? true,
    ),
    recallPeerScope:
      String(env.OPENVIKING_RECALL_PEER_SCOPE || pluginConfig.recallPeerScope || "all")
        .toLowerCase() === "actor" ? "actor" : "all",
    // Server-side query expansion costs a model call before retrieval; expose
    // the same opt-out the pi extension ships. Only sent when configured.
    recallQueryExpansion:
      String(env.OPENVIKING_RECALL_QUERY_EXPANSION || pluginConfig.recallQueryExpansion || "auto")
        .toLowerCase() === "off" ? "off" : "auto",
    recallQueryExpansionConfigured: Boolean(
      env.OPENVIKING_RECALL_QUERY_EXPANSION
      || pluginConfig.recallQueryExpansion,
    ),
    minQueryLength: num(env.OPENVIKING_RECALL_MIN_QUERY_LENGTH, pluginConfig.minQueryLength ?? 3, 0),
    profileInject: bool(env.OPENVIKING_PROFILE_INJECT, pluginConfig.profileInject ?? false),
    profileTokenBudget: num(
      env.OPENVIKING_PROFILE_TOKEN_BUDGET,
      pluginConfig.profileTokenBudget ?? 4000,
      200,
    ),
    captureSubagents: bool(
      env.OPENVIKING_CAPTURE_SUBAGENTS,
      pluginConfig.captureSubagents ?? false,
    ),
    captureToolMaxChars: num(
      env.OPENVIKING_CAPTURE_TOOL_MAX_CHARS,
      pluginConfig.captureToolMaxChars ?? 2000,
      100,
    ),
    timeoutMs: num(env.OPENVIKING_TIMEOUT_MS, pluginConfig.timeoutMs ?? 15000, 1000),
    commitTurnThreshold: num(
      env.OPENVIKING_COMMIT_TURN_THRESHOLD,
      pluginConfig.commitTurnThreshold ?? 8,
      1,
    ),
    commitTokenThreshold: num(
      env.OPENVIKING_COMMIT_TOKEN_THRESHOLD,
      pluginConfig.commitTokenThreshold ?? 20000,
      0,
    ),
    commitKeepRecentCount: num(
      env.OPENVIKING_COMMIT_KEEP_RECENT_COUNT,
      pluginConfig.commitKeepRecentCount ?? 0,
      0,
    ),
    resumeContextBudget: num(
      env.OPENVIKING_RESUME_CONTEXT_BUDGET,
      pluginConfig.resumeContextBudget ?? 0,
      0,
    ),
    captureTools: bool(env.OPENVIKING_CAPTURE_TOOLS, pluginConfig.captureTools ?? false),
    debug: bool(env.OPENVIKING_DEBUG, pluginConfig.debug ?? false),
    debugLogPath:
      env.OPENVIKING_DEBUG_LOG
      || pluginConfig.debugLogPath
      || join(homedir(), ".openviking", "logs", "dsh-plugin.log"),
  };
  return cfg;
}
