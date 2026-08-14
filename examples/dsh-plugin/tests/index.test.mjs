// index.mjs wiring tests: session-start injection behavior for subagents.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { apply } from "../src/index.mjs";

const SAVED_FETCH = globalThis.fetch;
const calls = [];

function mockCtx() {
  const handlers = {};
  return {
    handlers,
    on(event, handler) {
      handlers[event] = handler;
    },
    effect() {},
    provide() {},
    inject(services, factory) {
      factory({ commands: { register() {} } });
    },
    tools: { register() {} },
    systemPrompt: { section() {} },
    logger: { debug() {}, warn() {}, info() {}, error() {} },
  };
}

function stubFetch(responder) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (responder) {
      const overridden = await responder(u);
      if (overridden) return overridden;
    }
    if (u.includes("/system/status")) return { ok: true, status: 200, json: async () => ({ ok: true, result: { user: "smoke" } }) };
    if (u.includes("/fs/ls")) return { ok: true, status: 200, json: async () => ({ ok: true, result: [{ name: "smoke", isDir: true }] }) };
    if (u.includes("/content/read")) return { ok: true, status: 200, json: async () => ({ ok: true, result: "# Profile\n- prefers dark mode" }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
}

afterEach(() => {
  globalThis.fetch = SAVED_FETCH;
  calls.length = 0;
});

test("session-start injects profile for a normal session", async () => {
  stubFetch();
  const ctx = mockCtx();
  apply(ctx, { enabled: true, profileInject: true, profileTokenBudget: 6000 });
  const handler = ctx.handlers["agent/session-start"];
  assert.ok(handler, "session-start handler registered");

  const injected = [];
  await handler({ agent: { session: { id: "main-1", header: { cwd: "/tmp/project" } }, status: "idle", inject: (message) => injected.push(message) } });
  assert.equal(injected.length, 1, "profile injected for a normal session");
  assert.equal(injected[0].source?.kind, "plugin");
});

test("session-start skips injection for subagent sessions", async () => {
  stubFetch();
  const ctx = mockCtx();
  apply(ctx, { enabled: true, profileInject: true, profileTokenBudget: 6000 });
  const handler = ctx.handlers["agent/session-start"];

  const injected = [];
  await handler({ agent: { session: { id: "sub-9", header: { cwd: "/tmp/project", parentSession: "main-1" } }, status: "idle", inject: (message) => injected.push(message) } });
  assert.equal(injected.length, 0, "subagent gets no profile injection");
  assert.equal(calls.length, 0, "no profile fetch for subagent");
});

test("session-start injects archive overview for resumed sessions", async () => {
  stubFetch((url) => {
    if (url.includes("/sessions/") && url.includes("/context")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { latest_archive_overview: "## Working Memory\n- prior context" } }) };
    }
    return null;
  });
  const ctx = mockCtx();
  apply(ctx, { enabled: true, profileInject: false, resumeContextBudget: 32000 });
  const handler = ctx.handlers["agent/session-start"];

  const injected = [];
  await handler({ agent: { session: { id: "resumed-1", header: { cwd: "/tmp/project" } }, status: "idle", inject: (message) => injected.push(message) } });
  assert.equal(injected.length, 1, "archive overview injected for resumed session");
  assert.ok(injected[0].content[0].text.includes("<session-archive>"), "overview wrapped in session-archive");
  assert.ok(injected[0].content[0].text.includes("prior context"), "overview content present");
});

test("archive failure does not drop the profile block", async () => {
  stubFetch((url) => {
    if (url.includes("/sessions/") && url.includes("/context")) {
      return { ok: false, status: 500, json: async () => ({ ok: false, error: { message: "boom" } }) };
    }
    return null;
  });
  const ctx = mockCtx();
  apply(ctx, { enabled: true, profileInject: true, profileTokenBudget: 6000, resumeContextBudget: 32000 });
  const handler = ctx.handlers["agent/session-start"];

  const injected = [];
  await handler({ agent: { session: { id: "main-2", header: { cwd: "/tmp/project" } }, status: "idle", inject: (message) => injected.push(message) } });
  assert.equal(injected.length, 1, "profile still injected when archive fetch fails");
  assert.ok(injected[0].content[0].text.includes("<user-profile"), "profile block present");
});
