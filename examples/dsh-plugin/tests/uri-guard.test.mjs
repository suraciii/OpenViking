// viking:// URI guard tests.
import assert from "node:assert/strict";
import { test } from "node:test";

import { installUriGuard } from "../src/uri-guard.mjs";
import { evaluateAgentUriGuard } from "../src/shared/agent-uri-guard.mjs";

test("evaluateAgentUriGuard flags local reads of viking:// URIs", () => {
  const hit = evaluateAgentUriGuard("read", { path: "viking://resources/docs/auth.md" });
  assert.ok(hit);
  assert.match(hit.reason, /viking:\/\//);
  assert.match(hit.reason, /openviking/i);
});

test("evaluateAgentUriGuard ignores ordinary paths and other tools", () => {
  assert.equal(evaluateAgentUriGuard("read", { path: "/tmp/notes.md" }), null);
  assert.equal(evaluateAgentUriGuard("write_file", { path: "viking://resources/x" }), null);
  assert.equal(evaluateAgentUriGuard("bash", { command: "ls" }), null);
});

test("guard denies matching executions and passes through everything else", async () => {
  const decisions = [];
  const ctx = {
    on: (event, handler) => {
      assert.equal(event, "tools/pre-execute");
      decisions.push(handler);
    },
  };
  installUriGuard(ctx, { enabled: true });

  const denied = await decisions[0](
    { name: "read", arguments: { path: "viking://resources/docs/auth.md" } },
    async () => ({ kind: "allow" }),
  );
  assert.equal(denied.kind, "deny");

  const allowed = await decisions[0](
    { name: "read", arguments: { path: "/tmp/notes.md" } },
    async () => ({ kind: "allow" }),
  );
  assert.equal(allowed.kind, "allow");
});

test("uriGuard: false disables the gate", async () => {
  let installed = false;
  installUriGuard({ on: () => { installed = true; } }, { enabled: true, uriGuard: false });
  assert.equal(installed, false);
});
