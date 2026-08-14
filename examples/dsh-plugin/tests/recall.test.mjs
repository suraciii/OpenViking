// Recall injection tests: pre-step waterfall appends a recall notice when the
// step admits a real human prompt.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { installRecall } from "../src/recall.mjs";
import { createClient } from "../src/client.mjs";

const SAVED_FETCH = globalThis.fetch;

function stubFetch() {
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/api/v1/search/search")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { rendered: "RECALL BLOCK", entries: [], digest: "", stats: {} } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: {} }),
    };
  };
}

afterEach(() => {
  globalThis.fetch = SAVED_FETCH;
});

function makeHarness(cfg) {
  const handlers = {};
  const ctx = {
    on: (event, handler) => { handlers[event] = handler; },
    logger: { debug: () => {}, warn: () => {} },
  };
  const session = { id: "sess-1", header: { cwd: "/tmp/project" } };
  const states = new Map();
  const tracker = {
    stateFor: () => {
      let state = states.get("sess-1");
      if (!state) {
        state = {
          sessionId: "sess-1",
          ovSessionId: "dsh-sess-1",
          cwd: "/tmp/project",
          client: createClient({ baseUrl: "http://localhost:1933", timeoutMs: 5000, ...cfg }, "/tmp/project"),
          pending: [],
          turnsSinceCommit: 0,
        };
        states.set("sess-1", state);
      }
      return state;
    },
  };
  installRecall(ctx, cfg, tracker);
  return { handlers, session };
}

function humanMessage(text) {
  return { id: "msg-1", role: "user", source: { kind: "user" }, content: [{ type: "text", text }] };
}

test("appends a recall notice message to the enter decision", async () => {
  stubFetch();
  const { handlers, session } = makeHarness({ enabled: true, autoRecall: true, timeoutMs: 5000 });
  const decision = await handlers["agent/pre-step"](
    { agent: { session }, signal: undefined, turn: 1, step: 1 },
    async () => ({ kind: "enter", messages: [humanMessage("what do we know about auth?")] }),
  );
  assert.equal(decision.kind, "enter");
  assert.equal(decision.messages.length, 2);
  const recall = decision.messages[1];
  assert.equal(recall.source.kind, "plugin");
  assert.equal(recall.source.plugin, "openviking");
  assert.equal(recall.source.form, "notice");
  assert.match(recall.content[0].text, /RECALL BLOCK/);
});

test("leaves the decision untouched when recall is disabled", async () => {
  const { handlers, session } = makeHarness({ enabled: true, autoRecall: false });
  const original = { kind: "enter", messages: [humanMessage("hello")] };
  const decision = await handlers["agent/pre-step"](
    { agent: { session }, signal: undefined, turn: 1, step: 1 },
    async () => original,
  );
  assert.equal(decision, original);
});

test("does not recall for plugin-sourced or tool-sourced messages", async () => {
  const { handlers, session } = makeHarness({ enabled: true, autoRecall: true });
  const original = {
    kind: "enter",
    messages: [{ id: "msg-2", role: "user", source: { kind: "plugin", plugin: "goal" }, content: [{ type: "text", text: "round" }] }],
  };
  const decision = await handlers["agent/pre-step"](
    { agent: { session }, signal: undefined, turn: 1, step: 1 },
    async () => original,
  );
  assert.equal(decision, original);
});

test("preserves the decision when recall fails", async () => {
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  const { handlers, session } = makeHarness({ enabled: true, autoRecall: true, timeoutMs: 1000 });
  const original = { kind: "enter", messages: [humanMessage("hello")] };
  const decision = await handlers["agent/pre-step"](
    { agent: { session }, signal: undefined, turn: 1, step: 1 },
    async () => original,
  );
  assert.equal(decision, original);
});
