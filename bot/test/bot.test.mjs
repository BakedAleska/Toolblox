import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMANDS, respond } from "../src/commands.ts";
import { verifyInteraction } from "../src/discord.ts";
import { countDownloads, downloadIncrease, formatIncrease, formatVersion } from "../src/releases.ts";

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

test("counts installers and updates and ignores signatures and notices", () => {
  const asset = (name, download_count) => ({ name, download_count });
  const releases = [
    { tag_name: "v0.3.1-beta", html_url: "", draft: false, assets: [
      asset("Toolblox-Setup.exe", 1), asset("Toolblox-Setup.exe.sig", 2), asset("Toolblox-Update.exe", 3),
      asset("Toolblox.app.tar.gz", 2), asset("Toolblox.app.tar.gz.sig", 2), asset("Toolblox.dmg", 3),
      asset("THIRD-PARTY-NOTICES.txt", 2),
    ] },
    { tag_name: "v0.2.0-beta", html_url: "", draft: false, assets: [asset("Toolblox-Setup.exe", 46)] },
  ];
  assert.deepEqual(countDownloads(releases), { windows: 47, macos: 3, updates: 5 });
});

test("reports only kinds that grew", () => {
  const previous = { windows: 47, macos: 3, updates: 5 };
  assert.equal(downloadIncrease(previous, previous), null);
  assert.equal(downloadIncrease(previous, { windows: 40, macos: 3, updates: 5 }), null);

  const current = { windows: 48, macos: 3, updates: 7 };
  const increase = downloadIncrease(previous, current);
  assert.deepEqual(increase, { windows: 1, macos: 0, updates: 2 });
  assert.equal(formatIncrease(increase, current), "New downloads: Windows +1, Updates +2\nTotal: Windows 48 · macOS 3 · Updates 7");
});

test("formats release tags", () => {
  assert.equal(formatVersion("v0.3.1-beta"), "0.3.1 beta");
  assert.equal(formatVersion("v1.0.0"), "1.0.0");
});

test("answers every registered command", async () => {
  assert.deepEqual(COMMANDS.map((command) => command.name), ["link", "docs", "source", "version"]);
  for (const command of COMMANDS) assert.ok(command.description.length <= 100);
  assert.equal(await respond("link"), "Download Toolblox: https://toolblox.dev/");
  assert.equal(await respond("unknown"), "This command isn't supported.");
});
