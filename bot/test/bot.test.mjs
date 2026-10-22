import assert from "node:assert/strict";
import { test } from "node:test";

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
