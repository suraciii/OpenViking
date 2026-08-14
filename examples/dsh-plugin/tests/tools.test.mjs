// Tool registration and execution tests with a stubbed global fetch.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { installTools } from "../src/tools.mjs";
import { createClient } from "../src/client.mjs";

const SAVED_FETCH = globalThis.fetch;
const calls = [];

function stubFetch(result) {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ result }),
    };
  };
}

afterEach(() => {
  globalThis.fetch = SAVED_FETCH;
  calls.length = 0;
});

function makeHarness(cfg) {
  const registered = [];
  const ctx = {
    tools: { register: (definition) => registered.push(definition) },
  };
  const session = { id: "sess-1", header: { cwd: "/tmp/project" } };
  installTools(ctx, cfg, makeTracker(session, cfg));
  return { registered, session };
}

function makeTracker(session, cfg) {
  const states = new Map();
  return {
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
    flushAndCommit: async () => "dsh-sess-1",
  };
}

function exec(session) {
  return { agent: { session }, signal: undefined };
}

test("registers the expected tool set with schemas and render", () => {
  const { registered } = makeHarness({});
  const names = registered.map((definition) => definition.name).sort();
  assert.deepEqual(names, [
    "openviking_commit",
    "openviking_find",
    "openviking_health",
    "openviking_list",
    "openviking_read",
    "openviking_remember",
    "openviking_search",
  ]);
  for (const definition of registered) {
    assert.equal(typeof definition.execute, "function");
    assert.equal(typeof definition.output.render, "function");
    assert.equal(definition.output.schema.type, "string");
  }
});

test("openviking_health reports healthy", async () => {
  stubFetch({});
  const { registered, session } = makeHarness({});
  const health = registered.find((definition) => definition.name === "openviking_health");
  const text = await health.execute({}, exec(session));
  assert.match(text, /^OpenViking healthy/);
  assert.ok(calls.some((call) => call.url.includes("/api/v1/system/status")));
});

test("openviking_read returns file content", async () => {
  stubFetch({ content: "FILE CONTENT" });
  const { registered, session } = makeHarness({});
  const read = registered.find((definition) => definition.name === "openviking_read");
  const text = await read.execute({ uri: "viking://resources/x.md" }, exec(session));
  assert.equal(text, "FILE CONTENT");
  assert.ok(calls.some((call) => call.url.includes("/api/v1/content/read?uri=viking%3A%2F%2Fresources%2Fx.md")));
});

test("openviking_list renders entries", async () => {
  stubFetch({ entries: [{ name: "docs", type: "dir" }, { name: "api.md", type: "file" }] });
  const { registered, session } = makeHarness({});
  const list = registered.find((definition) => definition.name === "openviking_list");
  const text = await list.execute({ uri: "viking://resources/" }, exec(session));
  assert.match(text, /docs/);
  assert.match(text, /api\.md/);
});

test("openviking_remember stores and commits a one-off session", async () => {
  stubFetch({ archive_uri: "viking://user/u/memories/archives/a" });
  const { registered, session } = makeHarness({});
  const remember = registered.find((definition) => definition.name === "openviking_remember");
  const text = await remember.execute(
    { messages: [{ role: "user", content: "prefers tabs" }] },
    exec(session),
  );
  const parsed = JSON.parse(text);
  assert.equal(parsed.status, "success");
  assert.equal(parsed.message_count, 1);
  assert.ok(calls.some((call) => call.url.includes("/messages/batch")));
  assert.ok(calls.some((call) => call.url.includes("/commit")));
});

test("openviking_remember rejects empty payloads", async () => {
  stubFetch({});
  const { registered, session } = makeHarness({});
  const remember = registered.find((definition) => definition.name === "openviking_remember");
  const text = await remember.execute({ messages: [] }, exec(session));
  assert.match(text, /provide at least one/);
});
