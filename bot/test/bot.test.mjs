import assert from "node:assert/strict";
import { test } from "node:test";

import { byVersion, changelogEmbed, parseChangelog, pendingChangelogs, syncChangelogs } from "../src/changelogs.ts";
import { COMMANDS, respond } from "../src/commands.ts";
import { verifyInteraction } from "../src/discord.ts";
import {
  countDownloads,
  downloadIncrease,
  formatIncrease,
  formatTotals,
  formatVersion,
  highestTotals,
} from "../src/releases.ts";

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

test("counts installers only, skipping updates and installers that doubled as updates", () => {
  const asset = (name, download_count) => ({ name, download_count });
  const releases = [
    { tag_name: "v0.3.1-beta", html_url: "", draft: false, assets: [
      asset("Toolblox-Setup.exe", 5), asset("Toolblox-Setup.exe.sig", 6), asset("Toolblox-Update.exe", 7),
      asset("Toolblox.app.tar.gz", 6), asset("Toolblox.app.tar.gz.sig", 6), asset("Toolblox.dmg", 4),
      asset("THIRD-PARTY-NOTICES.txt", 8),
    ] },
    { tag_name: "v0.3.0-beta", html_url: "", draft: false, assets: [
      asset("Toolblox-Setup.exe", 2), asset("Toolblox-Update.exe", 4), asset("Toolblox.dmg", 1),
    ] },
    { tag_name: "v0.2.0-beta", html_url: "", draft: false, assets: [asset("Toolblox-Setup.exe", 46)] },
  ];
  assert.deepEqual(countDownloads(releases), { windows: 7, macos: 5 });
});

test("reports growth as a total and its split", () => {
  const previous = { windows: 7, macos: 5 };
  assert.equal(downloadIncrease(previous, previous), null);
  assert.equal(downloadIncrease(previous, { windows: 6, macos: 5 }), null);

  const current = { windows: 9, macos: 5 };
  const increase = downloadIncrease(previous, current);
  assert.deepEqual(increase, { windows: 2, macos: 0 });
  assert.equal(formatIncrease(increase, current), "New downloads: +2 (Windows +2, macOS +0)\nTotal: 14 (Windows 9, macOS 5)");
  assert.equal(formatTotals(previous), "12 (Windows 7, macOS 5)");
});

test("keeps the highest counts when GitHub reports fewer downloads", () => {
  const saved = { windows: 9, macos: 7 };
  const bad = { windows: 0, macos: 0 };
  assert.equal(downloadIncrease(saved, bad), null);
  assert.deepEqual(highestTotals(saved, bad), saved);
  assert.equal(downloadIncrease(highestTotals(saved, bad), saved), null);

  const partial = { windows: 10, macos: 0 };
  assert.deepEqual(downloadIncrease(saved, partial), { windows: 1, macos: 0 });
  assert.deepEqual(highestTotals(saved, partial), { windows: 10, macos: 7 });
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

test("builds an embed linked to the release and within Discord's limit", () => {
  const embed = changelogEmbed({ version: "0.3.1-beta", title: "Toolblox 0.3.1 beta", date: "October 16, 2026", body: "x".repeat(5000), released: true });
  assert.equal(embed.url, "https://github.com/BakedAleska/Toolblox/releases/tag/v0.3.1-beta");
  assert.equal(embed.description.length, 4096);
  assert.ok(embed.description.endsWith("…"));
  assert.equal(embed.footer.text, "October 16, 2026");
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
    assert.deepEqual(saved["0.2.0-beta"], { sha: "a", messageId: "100" });
    assert.deepEqual(saved["0.3.0-beta"], { sha: "b", messageId: "101" });
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
    assert.equal(JSON.parse(store.get("changelogs"))["0.3.2-beta"].messageId, "102");
  } finally {
    globalThis.fetch = original;
  }
});
