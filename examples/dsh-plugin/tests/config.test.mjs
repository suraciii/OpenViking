// Unit tests for the dsh plugin config resolution.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { resolveDshConfig } from "../src/config.mjs";

const SAVED_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED_ENV)) delete process.env[key];
  }
  Object.assign(process.env, SAVED_ENV);
});

test("resolveDshConfig defaults", () => {
  const cfg = resolveDshConfig({});
  assert.equal(typeof cfg.baseUrl, "string");
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.autoRecall, true);
  assert.equal(cfg.autoCapture, true);
  assert.equal(cfg.commitTurnThreshold, 0);
  assert.equal(cfg.timeoutMs, 15000);
  assert.equal(cfg.recallLimit, 6);
  assert.equal(cfg.recallPeerScope, "all");
  assert.equal(cfg.captureTools, false);
  assert.equal(cfg.userAgent, "openviking-memory-dsh/0.0.0");
});

test("resolveDshConfig plugin config wins over env and credentials", () => {
  process.env.OPENVIKING_BASE_URL = "http://env:1933";
  process.env.OPENVIKING_RECALL_LIMIT = "3";
  const cfg = resolveDshConfig({
    baseUrl: "http://plugin:1933",
    autoRecall: false,
    commitTurnThreshold: 2,
  });
  assert.equal(cfg.baseUrl, "http://plugin:1933");
  assert.equal(cfg.autoRecall, false);
  assert.equal(cfg.commitTurnThreshold, 2);
  assert.equal(cfg.recallLimit, 3);
});

test("resolveDshConfig honors OPENVIKING_* env knobs when plugin config is silent", () => {
  process.env.OPENVIKING_AUTO_CAPTURE = "0";
  process.env.OPENVIKING_COMMIT_TURN_THRESHOLD = "4";
  process.env.OPENVIKING_TIMEOUT_MS = "7000";
  process.env.OPENVIKING_RECALL_PEER_SCOPE = "actor";
  const cfg = resolveDshConfig({});
  assert.equal(cfg.autoCapture, false);
  assert.equal(cfg.commitTurnThreshold, 4);
  assert.equal(cfg.timeoutMs, 7000);
  assert.equal(cfg.recallPeerScope, "actor");
});

test("resolveDshConfig accepts endpoint as an alias for baseUrl", () => {
  const cfg = resolveDshConfig({ endpoint: "http://alias:1933" });
  assert.equal(cfg.baseUrl, "http://alias:1933");
});

test("resolveDshConfig derives baseUrl from ovcli-style credentials when unset", () => {
  process.env.OPENVIKING_CLI_CONFIG_FILE = "/nonexistent/ovcli.conf";
  const cfg = resolveDshConfig({});
  assert.equal(typeof cfg.baseUrl, "string");
  assert.ok(cfg.baseUrl.startsWith("http"));
});
