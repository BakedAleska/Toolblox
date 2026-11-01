import assert from "node:assert/strict";
import { test } from "node:test";

import { byVersion, changelogEmbeds, parseChangelog, pendingChangelogs, syncChangelogs } from "../src/changelogs.ts";
import { COMMANDS, respond } from "../src/commands.ts";
import { verifyInteraction } from "../src/discord.ts";
import worker from "../src/index.ts";
import { MAX_PER_WINDOW, allowRequest, rateKey } from "../src/limit.ts";
import { parseSurvey, surveyEmbed } from "../src/survey.ts";
import {
  compareStats,
  countDownloads,
  countUpdates,
  formatDailyReport,
  formatStats,
  formatTotals,
  formatVersion,
  highestTotals,
  latestCounts,
  reportClock,
  totalsIncrease,
} from "../src/releases.ts";

/** An in-memory stand-in for the KV namespace. */
function memoryState() {
  const store = new Map();
  return {
    store,
    get: async (key, type) => (store.has(key) ? (type === "json" ? JSON.parse(store.get(key)) : store.get(key)) : null),
    put: async (key, value) => void store.set(key, value),
  };
}

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

test("counts updates, subtracting manifest builds from releases without checksums", () => {
  const asset = (name, download_count) => ({ name, download_count });
  const releases = [
    { tag_name: "v0.5.0-beta", html_url: "", draft: false, assets: [
      asset("SHA256SUMS", 9), asset("Toolblox-Setup.exe.sig", 9), asset("Toolblox-Update.exe", 4),
      asset("Toolblox.app.tar.gz.sig", 9), asset("Toolblox.app.tar.gz", 3),
    ] },
    { tag_name: "v0.4.0-beta", html_url: "", draft: false, assets: [
      asset("Toolblox-Setup.exe.sig", 11), asset("Toolblox-Update.exe", 12),
      asset("Toolblox.app.tar.gz.sig", 11), asset("Toolblox.app.tar.gz", 13),
    ] },
    { tag_name: "v0.3.1-beta", html_url: "", draft: false, assets: [
      asset("Toolblox-Setup.exe.sig", 14), asset("Toolblox-Update.exe", 13),
    ] },
    { tag_name: "v0.2.0-beta", html_url: "", draft: false, assets: [asset("Toolblox-Setup.exe", 46), asset("Toolblox-Setup.exe.sig", 37)] },
  ];
  assert.deepEqual(countUpdates(releases), { windows: 5, macos: 5 });
});

test("reports each metric that grew, then every total", () => {
  const previous = { windows: 7, macos: 5 };
  assert.equal(totalsIncrease(previous, previous), null);
  assert.equal(totalsIncrease(previous, { windows: 6, macos: 5 }), null);
  assert.deepEqual(totalsIncrease(previous, { windows: 9, macos: 5 }), { windows: 2, macos: 0 });
  assert.deepEqual(totalsIncrease(undefined, { windows: 1, macos: 0 }), { windows: 1, macos: 0 });
  assert.equal(formatTotals(previous), "12 (Windows 7, macOS 5)");

  const saved = { downloads: { windows: 7, macos: 5 }, users: { windows: 2, macos: 1 }, updates: { windows: 3, macos: 1 } };
  const current = { downloads: { windows: 9, macos: 5 }, users: { windows: 3, macos: 1 }, updates: { windows: 3, macos: 1 } };
  const { increases, totals } = compareStats(saved, current);
  assert.deepEqual(increases, { downloads: { windows: 2, macos: 0 }, users: { windows: 1, macos: 0 } });
  assert.deepEqual(totals, current);
  assert.equal(formatDailyReport({
    date: "October 31, 2026",
    increases,
    totals,
    latest: { tag: "v0.4.5-beta", publishedAt: "2026-11-01T02:23:45Z", downloads: { windows: 2, macos: 1 }, updates: { windows: 1, macos: 0 } },
  }), [
    "**Daily report · October 31, 2026**",
    "",
    "**Downloads:** 14 (Windows 9, macOS 5)",
    "Today: +2 (Windows +2, macOS +0)",
    "**Users:** 4 (Windows 3, macOS 1)",
    "Today: +1 (Windows +1, macOS +0)",
    "**Updates:** 4 (Windows 3, macOS 1)",
    "Today: +0 (Windows +0, macOS +0)",
    "Re-downloads and other sources today: +1",
    "",
    "**Latest version: 0.4.5 beta** (released November 1, 2026)",
    "Downloads: 3 (Windows 2, macOS 1)",
    "Updates: 1 (Windows 1, macOS 0)",
  ].join("\n"));
  assert.equal(formatStats(saved).split("\n").length, 3);
});

test("keeps the highest counts when a response reports fewer", () => {
  const saved = { windows: 9, macos: 7 };
  const bad = { windows: 0, macos: 0 };
  assert.equal(totalsIncrease(saved, bad), null);
  assert.deepEqual(highestTotals(saved, bad), saved);
  assert.equal(totalsIncrease(highestTotals(saved, bad), saved), null);

  const partial = { windows: 10, macos: 0 };
  assert.deepEqual(totalsIncrease(saved, partial), { windows: 1, macos: 0 });
  assert.deepEqual(highestTotals(saved, partial), { windows: 10, macos: 7 });

  const { increases, totals } = compareStats({ downloads: saved }, { downloads: bad, users: bad, updates: { windows: 1, macos: 0 } });
  assert.deepEqual(increases, { updates: { windows: 1, macos: 0 } });
  assert.deepEqual(totals.downloads, saved);
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

test("accepts only valid survey answers", () => {
  const answers = (value) => parseSurvey(JSON.stringify(value));
  assert.deepEqual(answers({ rating: 4, comment: "  Good  ", version: "0.4.1-beta" }), { rating: 4, comment: "Good", version: "0.4.1-beta" });
  assert.equal(answers({ rating: 0, comment: "", version: "0.4.1" }), null);
  assert.equal(answers({ rating: 6, comment: "", version: "0.4.1" }), null);
  assert.equal(answers({ rating: 2.5, comment: "", version: "0.4.1" }), null);
  assert.equal(answers({ rating: "4", comment: "", version: "0.4.1" }), null);
  assert.equal(answers({ rating: 4, comment: "a".repeat(2001), version: "0.4.1" }), null);
  assert.equal(answers({ rating: 4, comment: "", version: "latest" }), null);
  assert.equal(answers({ rating: 4, version: "0.4.1" }), null);
  assert.equal(parseSurvey("not json"), null);
  assert.equal(parseSurvey("null"), null);
});

test("formats survey answers as an embed", () => {
  assert.deepEqual(surveyEmbed({ rating: 5, comment: "", version: "0.4.1-beta" }), {
    title: "Beta survey: 5/5",
    description: "*No comment.*",
    footer: { text: "Toolblox 0.4.1-beta" },
  });
});

test("limits requests per address and scope without storing the address", async () => {
  const { store, ...state } = memoryState();
  for (let count = 0; count < MAX_PER_WINDOW; count++) assert.equal(await allowRequest(state, "survey", "203.0.113.7"), true);
  assert.equal(await allowRequest(state, "survey", "203.0.113.7"), false);
  assert.equal(await allowRequest(state, "download", "203.0.113.7"), true);
  assert.equal(await allowRequest(state, "survey", "203.0.113.8"), true);
  assert.ok([...store.keys()].every((key) => !key.includes("203.0.113")));
  assert.equal(store.get(await rateKey("survey", "203.0.113.7")), String(MAX_PER_WINDOW));
});

test("counts first downloads from the website by platform only", async () => {
  const state = memoryState();
  const env = { STATE: state };
  const send = (platform, init = {}) =>
    worker.fetch(new Request(`https://bot.test/download?platform=${platform}`, {
      method: "POST",
      ...init,
      headers: { Origin: "https://toolblox.dev", "CF-Connecting-IP": "203.0.113.9", ...init.headers },
    }), env);

  assert.equal((await send("windows")).status, 204);
  assert.equal((await send("macos")).status, 204);
  assert.equal((await send("linux")).status, 400);
  assert.equal((await send("windows", { headers: { Origin: "https://example.test" } })).status, 403);
  assert.equal((await send("windows", { method: "GET" })).status, 404);
  assert.deepEqual(JSON.parse(state.store.get("users")), { windows: 1, macos: 1 });

  assert.equal((await send("windows")).status, 204);
  assert.equal((await send("windows")).status, 429);
  assert.deepEqual(JSON.parse(state.store.get("users")), { windows: 2, macos: 1 });
});

test("reads the report clock in New York time, across daylight saving", () => {
  assert.deepEqual(reportClock(new Date("2026-10-31T22:00:00Z")), { day: "2026-10-31", hour: 18, date: "October 31, 2026" });
  assert.deepEqual(reportClock(new Date("2026-11-02T23:00:00Z")), { day: "2026-11-02", hour: 18, date: "November 2, 2026" });
  assert.equal(reportClock(new Date("2026-11-01T03:30:00Z")).day, "2026-10-31");
});

test("counts the newest published release on its own", () => {
  const releases = [
    { tag_name: "v0.5.0-beta", html_url: "", published_at: "", draft: true, assets: [] },
    { tag_name: "v0.4.5-beta", html_url: "", published_at: "2026-11-01T02:23:45Z", draft: false, assets: [
      { name: "Toolblox-Setup.exe", download_count: 2 }, { name: "Toolblox-Update.exe", download_count: 3 },
      { name: "Toolblox-Setup.exe.sig", download_count: 1 }, { name: "Toolblox.dmg", download_count: 1 },
    ] },
  ];
  assert.deepEqual(latestCounts(releases), {
    tag: "v0.4.5-beta", publishedAt: "2026-11-01T02:23:45Z", downloads: { windows: 2, macos: 1 }, updates: { windows: 2, macos: 0 },
  });
  assert.equal(latestCounts([]), undefined);
});

test("sends the daily report once a day from 6 PM New York time", async () => {
  const state = memoryState();
  const messages = [];
  const releases = [{ tag_name: "v0.4.0-beta", html_url: "", published_at: "2026-10-22T20:14:14Z", draft: false, assets: [
    { name: "Toolblox-Setup.exe", download_count: 15 }, { name: "Toolblox-Update.exe", download_count: 12 },
    { name: "Toolblox-Setup.exe.sig", download_count: 11 }, { name: "Toolblox.dmg", download_count: 10 },
  ] }];
  let failDm = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (url.startsWith("https://api.github.com/repos/BakedAleska/Toolblox/releases")) return Response.json(releases);
    if (url.includes("/contents/changelogs")) return Response.json([]);
    if (url.endsWith("/users/@me/channels")) return failDm ? new Response("", { status: 500 }) : Response.json({ id: "dm" });
    if (url.endsWith("/channels/dm/messages")) {
      messages.push(JSON.parse(init.body).content);
      return Response.json({ id: "1" });
    }
    return new Response("Not found", { status: 404 });
  };
  const env = { STATE: state, DISCORD_BOT_TOKEN: "token\n", OWNER_USER_ID: "owner" };
  const run = (time) => worker.scheduled({ scheduledTime: Date.parse(time) }, env);
  try {
    await run("2026-10-31T21:55:00Z");
    assert.equal(messages.length, 0);

    await run("2026-10-31T22:00:00Z");
    assert.equal(messages.length, 1);
    assert.ok(messages[0].startsWith("**Daily report · October 31, 2026**\n\n**Downloads:** 25 (Windows 15, macOS 10)\nToday: +0"));
    assert.ok(messages[0].includes("**Latest version: 0.4.0 beta** (released October 22, 2026)\nDownloads: 25 (Windows 15, macOS 10)\nUpdates: 1 (Windows 1, macOS 0)"));

    await run("2026-10-31T22:05:00Z");
    assert.equal(messages.length, 1);

    state.store.set("users", JSON.stringify({ windows: 0, macos: 1 }));
    releases[0].assets[0].download_count = 18;
    failDm = true;
    await assert.rejects(run("2026-11-01T23:00:00Z"));
    failDm = false;
    await run("2026-11-01T23:05:00Z");
    assert.equal(messages.length, 2);
    assert.ok(messages[1].includes("**Downloads:** 28 (Windows 18, macOS 10)\nToday: +3 (Windows +3, macOS +0)"));
    assert.ok(messages[1].includes("**Users:** 1 (Windows 0, macOS 1)\nToday: +1 (Windows +0, macOS +1)"));
    assert.ok(messages[1].includes("Re-downloads and other sources today: +2"));
  } finally {
    globalThis.fetch = original;
  }
});
