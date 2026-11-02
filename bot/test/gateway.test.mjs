import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { STATUSES, findWelcomeChannel, presence, run, sendMessage, welcomeMessage } from "../gateway/index.mjs";

/** A stand-in for the Gateway socket that records what the bot sends. */
class FakeSocket {
  static OPEN = 1;
  static last;
  static count = 0;
  readyState = 1;
  sent = [];
  closeCalls = 0;
  listeners = {};
  constructor(url) {
    this.url = url;
    FakeSocket.last = this;
    FakeSocket.count++;
  }
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code) {
    this.closeCalls++;
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.listeners.close?.({ code });
  }
  async receive(payload) {
    await this.listeners.message({ data: JSON.stringify({ s: null, t: null, d: null, ...payload }) });
  }
}

test("finds the #welcome text channel and greets one member", () => {
  assert.equal(findWelcomeChannel([{ id: "1", name: "welcome", type: 2 }, { id: "2", name: "welcome", type: 0 }]), "2");
  assert.equal(findWelcomeChannel([{ id: "1", name: "general", type: 0 }]), undefined);
  assert.ok(welcomeMessage("42").startsWith("Welcome to Toolblox, <@42>.\nDownload Toolblox: https://toolblox.dev/"));
  for (const status of STATUSES) assert.ok(status.length <= 128);
  assert.deepEqual(presence("Hi").activities, [{ name: "Custom Status", type: 4, state: "Hi" }]);
});

test("identifies, greets members who join, skips bots, and resumes after a drop", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const originalSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const posts = [];
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return new Response("{}");
  };
  try {
    run("token");
    const socket = FakeSocket.last;
    await socket.receive({ op: 10, d: { heartbeat_interval: 41250 } });
    assert.equal(socket.sent[0].op, 2);
    assert.equal(socket.sent[0].d.intents, 3);
    assert.equal(socket.sent[0].d.presence.activities[0].type, 4);

    await socket.receive({ op: 0, t: "READY", s: 1, d: { session_id: "abc", resume_gateway_url: "wss://resume", user: { username: "Toolblox" } } });
    await socket.receive({ op: 0, t: "GUILD_CREATE", s: 2, d: { id: "g1", channels: [{ id: "w1", name: "welcome", type: 0 }] } });
    await socket.receive({ op: 0, t: "GUILD_MEMBER_ADD", s: 3, d: { guild_id: "g1", user: { id: "u1" } } });
    await socket.receive({ op: 0, t: "GUILD_MEMBER_ADD", s: 4, d: { guild_id: "g1", user: { id: "b1", bot: true } } });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "https://discord.com/api/v10/channels/w1/messages");
    assert.deepEqual(posts[0].body.allowed_mentions, { users: ["u1"] });

    mock.timers.tick(10 * 60 * 1000);
    assert.equal(socket.sent.at(-1).op, 3);

    socket.close(1006);
    mock.timers.tick(1000);
    const resumed = FakeSocket.last;
    assert.notEqual(resumed, socket);
    assert.equal(resumed.url, "wss://resume/?v=10&encoding=json");
    await resumed.receive({ op: 10, d: { heartbeat_interval: 41250 } });
    assert.deepEqual(resumed.sent[0], { op: 6, d: { token: "token", session_id: "abc", seq: 4 } });
    resumed.listeners.close = undefined;
  } finally {
    globalThis.WebSocket = originalSocket;
    globalThis.fetch = originalFetch;
    mock.timers.reset();
  }
});

test("stops the first heartbeat of a connection that closed before it fired", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  mock.method(Math, "random", () => 0.5);
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try {
    const before = FakeSocket.count;
    run("token");
    const dropped = FakeSocket.last;
    await dropped.receive({ op: 10, d: { heartbeat_interval: 40000 } });
    dropped.close(1006);
    mock.timers.tick(1000);
    await FakeSocket.last.receive({ op: 10, d: { heartbeat_interval: 40000 } });
    FakeSocket.last.sent.length = 0;
    mock.timers.tick(20000);
    assert.equal(FakeSocket.last.sent.filter(({ op }) => op === 1).length, 1);
    mock.timers.tick(200000);
    assert.equal(FakeSocket.count - before, 2);
    assert.equal(dropped.closeCalls, 1);
    FakeSocket.last.listeners.close = undefined;
  } finally {
    globalThis.WebSocket = originalSocket;
    mock.restoreAll();
    mock.timers.reset();
  }
});

test("retries a rate-limited welcome message after Discord's wait", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1 ? Response.json({ retry_after: 2 }, { status: 429 }) : new Response("{}"));
  try {
    const sent = sendMessage("token", "w1", "Hi", "u1");
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    mock.timers.tick(2000);
    await sent;
    assert.equal(calls, 2);

    calls = 0;
    globalThis.fetch = async () => (++calls, new Response("", { status: 403 }));
    await assert.rejects(sendMessage("token", "w1", "Hi", "u1"), /status 403/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    mock.timers.reset();
  }
});
