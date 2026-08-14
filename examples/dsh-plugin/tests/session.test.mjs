// Session capture/commit tests with a stubbed global fetch.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createSessionTracker } from "../src/session.mjs";

const SAVED_FETCH = globalThis.fetch;
const calls = [];

function stubFetch() {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: {} }),
    };
  };
}

afterEach(() => {
  globalThis.fetch = SAVED_FETCH;
  calls.length = 0;
});

function fakeSession(id = "sess-1") {
  return { id, header: { cwd: "/tmp/project" } };
}

function userEvent(text, source = { kind: "user" }) {
  return { type: "user/message", data: { source, content: [{ type: "text", text }] } };
}

function assistantEvent(text) {
  return {
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text }] } },
  };
}

function turnEndEvent(turn = 1) {
  return { type: "turn/end", data: { turn, reason: { kind: "completed" } } };
}

test("captures real user and assistant turns and flushes on turn/end", async () => {
  stubFetch();
  const cfg = { enabled: true, autoCapture: true, commitTurnThreshold: 8 };
  const tracker = createSessionTracker({}, cfg);
  const session = fakeSession();

  tracker.onSessionEvent(session, userEvent("hello world"));
  tracker.onSessionEvent(session, assistantEvent("hi there"));
  tracker.onSessionEvent(session, turnEndEvent(1));

  await new Promise((resolve) => setTimeout(resolve, 20));
  const batch = calls.find((call) => call.url.includes("/messages/batch"));
  assert.ok(batch, "expected a messages/batch call");
  const payload = JSON.parse(batch.body);
  assert.deepEqual(payload.messages, [
    { role: "user", content: "hello world" },
    { role: "assistant", content: "hi there" },
  ]);
  assert.ok(!calls.some((call) => call.url.includes("/commit")), "no commit before threshold");
});

test("ignores plugin-sourced user messages (recall/goal injections)", () => {
  stubFetch();
  const cfg = { enabled: true, autoCapture: true, commitTurnThreshold: 8 };
  const tracker = createSessionTracker({}, cfg);
  const session = fakeSession();

  tracker.onSessionEvent(session, userEvent("injected context", { kind: "plugin", plugin: "openviking" }));
  tracker.onSessionEvent(session, turnEndEvent(1));

  return new Promise((resolve) => setTimeout(resolve, 20)).then(() => {
    assert.equal(calls.length, 0, "nothing captured from plugin-sourced messages");
  });
});

test("commits when the turn threshold is reached", async () => {
  stubFetch();
  const cfg = { enabled: true, autoCapture: true, commitTurnThreshold: 2 };
  const tracker = createSessionTracker({}, cfg);
  const session = fakeSession();

  tracker.onSessionEvent(session, userEvent("turn one"));
  tracker.onSessionEvent(session, turnEndEvent(1));
  tracker.onSessionEvent(session, userEvent("turn two"));
  tracker.onSessionEvent(session, turnEndEvent(2));

  await new Promise((resolve) => setTimeout(resolve, 20));
  const commit = calls.find((call) => call.url.includes("/commit"));
  assert.ok(commit, "expected a commit call at threshold");
});

test("flushAndCommit flushes pending and commits", async () => {
  stubFetch();
  const cfg = { enabled: true, autoCapture: true, commitTurnThreshold: 8 };
  const tracker = createSessionTracker({}, cfg);
  const session = fakeSession();

  tracker.onSessionEvent(session, userEvent("remember me"));
  const id = await tracker.flushAndCommit(session);

  assert.equal(id, "dsh-sess-1");
  const commit = calls.find((call) => call.url.includes("/commit"));
  assert.ok(commit, "expected a commit call");
});

test("disposed agent flushes and commits detached", async () => {
  stubFetch();
  const cfg = { enabled: true, autoCapture: true, commitTurnThreshold: 8 };
  const tracker = createSessionTracker({}, cfg);
  const session = fakeSession();

  tracker.onSessionEvent(session, userEvent("last words"));
  tracker.onAgentDisposed({ session });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const commit = calls.find((call) => call.url.includes("/commit"));
  assert.ok(commit, "expected a commit call on disposal");
});

test("skips subagent sessions unless captureSubagents is set", async () => {
  stubFetch();
  const cfg = { enabled: true, autoCapture: true, commitTurnThreshold: 2 };
  const tracker = createSessionTracker({}, cfg);
  const sub = { id: "sub-1", header: { cwd: "/tmp/project", parentSession: "sess-1" } };

  tracker.onSessionEvent(sub, userEvent("delegated work"));
  tracker.onSessionEvent(sub, turnEndEvent(1));
  tracker.onAgentDisposed({ session: sub });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 0, "subagent sessions are not captured by default");

  const enabled = createSessionTracker({}, { ...cfg, captureSubagents: true });
  enabled.onSessionEvent(sub, userEvent("delegated work"));
  enabled.onSessionEvent(sub, turnEndEvent(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const batch = calls.find((call) => call.url.includes("/messages/batch"));
  assert.ok(batch, "captureSubagents: true captures subagent turns");
});

test("captureTools false keeps tool blocks out of captured text", async () => {
  stubFetch();
  const cfg = { enabled: true, autoCapture: true, commitTurnThreshold: 8 };
  const tracker = createSessionTracker({}, cfg);
  const session = fakeSession();

  tracker.onSessionEvent(session, {
    type: "assistant/message",
    data: {
      message: {
        content: [
          { type: "text", text: "plain answer" },
          { type: "tool-call", id: "tc-1", name: "bash", arguments: { command: "rm -rf /" } },
        ],
      },
    },
  });
  tracker.onSessionEvent(session, turnEndEvent(1));

  await new Promise((resolve) => setTimeout(resolve, 20));
  const batch = calls.find((call) => call.url.includes("/messages/batch"));
  const payload = JSON.parse(batch.body);
  assert.equal(payload.messages.length, 1, "only the assistant message is captured");
  assert.equal(payload.messages[0].content, "plain answer", "tool blocks are excluded");
});

test("captureTools true includes tool call text", async () => {
  stubFetch();
  const cfg = { enabled: true, autoCapture: true, captureTools: true, commitTurnThreshold: 8 };
  const tracker = createSessionTracker({}, cfg);
  const session = fakeSession();

  tracker.onSessionEvent(session, {
    type: "assistant/message",
    data: {
      message: {
        content: [
          { type: "text", text: "running it" },
          { type: "tool-call", id: "tc-1", name: "bash", arguments: { command: "ls" } },
        ],
      },
    },
  });
  tracker.onSessionEvent(session, turnEndEvent(1));

  await new Promise((resolve) => setTimeout(resolve, 20));
  const batch = calls.find((call) => call.url.includes("/messages/batch"));
  const payload = JSON.parse(batch.body);
  const captured = payload.messages[0].content;
  assert.ok(captured.includes("running it"), "text block present");
  assert.ok(captured.includes("bash"), "tool block present when captureTools is on");
});
