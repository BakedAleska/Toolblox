import assert from "node:assert/strict";
import { test } from "node:test";

import { byVersion, changelogEmbeds, parseChangelog, pendingChangelogs, syncChangelogs } from "../src/changelogs.ts";
import { COMMANDS, respond } from "../src/commands.ts";
import { verifyInteraction } from "../src/discord.ts";
import { formatVersion } from "../src/releases.ts";

const toHex = (bytes) => Buffer.from(bytes).toString("hex");

async function signer() {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = toHex(await crypto.subtle.exportKey("raw", keys.publicKey));
  const sign = async (message) =>
    toHex(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(message)));
  return { publicKey, sign };
}

test("accepts only bodies signed by the application key", async () => {
  const { publicKey, sign } = await signer();
  const other = await signer();
  const body = '{"type":1}';
  const signature = await sign(`1700000000${body}`);

  assert.equal(await verifyInteraction(body, signature, "1700000000", publicKey), true);
  assert.equal(await verifyInteraction('{"type":2}', signature, "1700000000", publicKey), false);
  assert.equal(await verifyInteraction(body, signature, "1700000001", publicKey), false);
  assert.equal(await verifyInteraction(body, signature, "1700000000", other.publicKey), false);
  assert.equal(await verifyInteraction(body, null, "1700000000", publicKey), false);
  assert.equal(await verifyInteraction(body, signature, null, publicKey), false);
  assert.equal(await verifyInteraction(body, "zz".repeat(64), "1700000000", publicKey), false);
  assert.equal(await verifyInteraction(body, signature.slice(2), "1700000000", publicKey), false);
  assert.equal(await verifyInteraction(body, signature, "1700000000", "REPLACE"), false);
});

test("formats release tags", () => {
  assert.equal(formatVersion("v0.3.1-beta"), "0.3.1 beta");
  assert.equal(formatVersion("v1.0.0"), "1.0.0");
});

test("answers every registered command", async () => {
  assert.deepEqual(COMMANDS.map((command) => command.name), ["link", "docs", "source", "version", "install"]);
  for (const command of COMMANDS) assert.ok(command.description.length <= 100);
  assert.equal(await respond("link"), "Download Toolblox: https://toolblox.dev/");
  assert.equal(await respond("unknown"), "This command isn't supported.");
});

test("reads released and unreleased changelogs", () => {
  const released = parseChangelog("0.3.1-beta", "# Toolblox 0.3.1 beta\n*October 16, 2026*\n\n## Changes\n- Fixed.\n");
  assert.deepEqual(released, { version: "0.3.1-beta", title: "Toolblox 0.3.1 beta", date: "October 16, 2026", body: "## Changes\n- Fixed.", released: true });
  assert.equal(parseChangelog("0.3.2-beta", "# Toolblox 0.3.2 beta\n*Unreleased*\n\n- New.").released, false);
  assert.equal(parseChangelog("0.4.0", "# Toolblox 0.4.0").released, false);
});

test("builds embeds linked to the release, one per part, within Discord's limit", () => {
  const changelog = { version: "0.3.1-beta", title: "Toolblox 0.3.1 beta", date: "October 16, 2026", body: "x".repeat(5000), released: true };
  const [embed] = changelogEmbeds(changelog);
  assert.equal(embed.url, "https://github.com/BakedAleska/Toolblox/releases/tag/v0.3.1-beta");
  assert.equal(embed.description.length, 4096);
  assert.ok(embed.description.endsWith("…"));
  assert.equal(embed.footer.text, "October 16, 2026");

  const parts = changelogEmbeds({ ...changelog, body: "## New\n- One.\n\n---\n\n## Fixed\n- Two.\n---\n" });
  assert.deepEqual(parts.map(({ description }) => description), ["## New\n- One.", "## Fixed\n- Two."]);
  assert.equal(parts[0].title, "Toolblox 0.3.1 beta");
  assert.equal(parts[0].footer, undefined);
  assert.equal(parts[1].title, undefined);
  assert.equal(parts[1].footer.text, "October 16, 2026");
});

test("lists new and changed changelogs, oldest version first", () => {
  assert.deepEqual(["0.10.0", "0.3.1-beta", "0.2.0-beta", "0.3.0-beta"].sort(byVersion), ["0.2.0-beta", "0.3.0-beta", "0.3.1-beta", "0.10.0"]);
  const files = [
    { version: "0.3.1-beta", sha: "c", url: "" },
    { version: "0.2.0-beta", sha: "a", url: "" },
    { version: "0.3.0-beta", sha: "b2", url: "" },
  ];
  const posted = { "0.2.0-beta": { sha: "a", messageId: "1" }, "0.3.0-beta": { sha: "b1", messageId: "2" } };
  assert.deepEqual(pendingChangelogs(files, posted).map(({ version }) => version), ["0.3.0-beta", "0.3.1-beta"]);
});

test("posts released changelogs once, edits changed ones, and skips unreleased ones", async () => {
  const store = new Map();
  const state = {
    get: async (key, type) => (store.has(key) ? (type === "json" ? JSON.parse(store.get(key)) : store.get(key)) : null),
    put: async (key, value) => void store.set(key, value),
  };
  const files = {
    "0.3.0-beta": { sha: "b", text: "# Toolblox 0.3.0 beta\n*October 1, 2026*\n\n- Two." },
    "0.2.0-beta": { sha: "a", text: "# Toolblox 0.2.0 beta\n*September 23, 2026*\n\n- One." },
    "0.3.2-beta": { sha: "d", text: "# Toolblox 0.3.2 beta\n*Unreleased*\n\n- Soon." },
  };
  const calls = [];
  let nextId = 100;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.includes("/contents/changelogs")) {
      return Response.json(Object.entries(files).map(([version, { sha }]) => ({ name: `${version}.md`, sha, type: "file", download_url: `raw:${version}` })));
    }
    if (url.startsWith("raw:")) return new Response(files[url.slice(4)].text);
    if (url.endsWith("/users/@me/guilds")) return Response.json([{ id: "g1" }]);
    if (url.endsWith("/guilds/g1/channels")) return Response.json([{ id: "c1", name: "changelogs", type: 0 }]);
    if (method === "POST") return Response.json({ id: String(nextId++), body: JSON.parse(init.body) });
    if (method === "PATCH") return Response.json({ id: url.split("/").pop() });
    return new Response("Not found", { status: 404 });
  };
  try {
    await syncChangelogs("token", state);
    const posts = calls.filter((call) => call.startsWith("POST"));
    assert.equal(posts.length, 2);
    const saved = JSON.parse(store.get("changelogs"));
    assert.deepEqual(saved["0.2.0-beta"], { sha: "a", messageIds: ["100"] });
    assert.deepEqual(saved["0.3.0-beta"], { sha: "b", messageIds: ["101"] });
    assert.deepEqual(saved["0.3.2-beta"], { sha: "d" });

    calls.length = 0;
    await syncChangelogs("token", state);
    assert.deepEqual(calls, ["GET https://api.github.com/repos/BakedAleska/Toolblox/contents/changelogs?ref=main"]);

    files["0.3.0-beta"] = { sha: "b2", text: "# Toolblox 0.3.0 beta\n*October 1, 2026*\n\n- Two, fixed." };
    files["0.3.2-beta"] = { sha: "d2", text: "# Toolblox 0.3.2 beta\n*October 30, 2026*\n\n- Out." };
    calls.length = 0;
    await syncChangelogs("token", state);
    assert.ok(calls.includes("PATCH https://discord.com/api/v10/channels/c1/messages/101"));
    assert.equal(calls.filter((call) => call.startsWith("POST")).length, 1);
    assert.deepEqual(JSON.parse(store.get("changelogs"))["0.3.2-beta"].messageIds, ["102"]);

    files["0.3.0-beta"] = { sha: "b3", text: "# Toolblox 0.3.0 beta\n*October 1, 2026*\n\n- New.\n\n---\n\n- Fixed." };
    calls.length = 0;
    await syncChangelogs("token", state);
    assert.ok(calls.includes("PATCH https://discord.com/api/v10/channels/c1/messages/101"));
    assert.deepEqual(JSON.parse(store.get("changelogs"))["0.3.0-beta"], { sha: "b3", messageIds: ["101", "103"] });

    files["0.3.0-beta"] = { sha: "b4", text: "# Toolblox 0.3.0 beta\n*October 1, 2026*\n\n- All." };
    calls.length = 0;
    await syncChangelogs("token", state);
    assert.ok(calls.includes("DELETE https://discord.com/api/v10/channels/c1/messages/103"));
    assert.deepEqual(JSON.parse(store.get("changelogs"))["0.3.0-beta"], { sha: "b4", messageIds: ["101"] });

    store.set("changelogs", JSON.stringify({ ...JSON.parse(store.get("changelogs")), "0.2.0-beta": { sha: "old", messageId: "100" } }));
    calls.length = 0;
    await syncChangelogs("token", state);
    assert.ok(calls.includes("PATCH https://discord.com/api/v10/channels/c1/messages/100"));
    assert.equal(calls.filter((call) => call.startsWith("POST")).length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
