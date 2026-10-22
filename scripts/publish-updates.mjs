/**
 * Builds the signed update manifest and widget catalogue for GitHub Pages.
 *
 * Reads the latest GitHub release, hashes its Windows installer and macOS app archive, and writes `_site/` from the
 * built site in `site/dist/` plus `updates/stable.json` and `catalogue/v1.json`, each with a detached Ed25519 `.sig`.
 * The catalogue lists every widget in `widgets/`, packaged under `catalogue/<id>/<version>/`.
 * Private keys are base64 32-byte seeds in `MANIFEST_PRIVATE_KEY` and `CATALOGUE_PRIVATE_KEY`.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { packageWidgets } from "./widgets.mjs";

const INSTALLER = "Toolblox-Setup.exe";
/** The same installer under a second name, so updates and manifest builds stay out of the download count of `INSTALLER`. Older releases don't have it. */
const UPDATER_INSTALLER = "Toolblox-Update.exe";
/** The universal macOS app archive, used for both Mac architectures. Older releases don't have it. */
const MACOS_ARCHIVE = "Toolblox.app.tar.gz";
const MANIFEST_LIFETIME = 7 * 24 * 60 * 60;
const CLOCK_ALLOWANCE = 60 * 60;
/** Where `_site/catalogue/` is served. */
const CATALOGUE_URL = "https://toolblox.dev/catalogue/";

const repository = process.env.GITHUB_REPOSITORY || "BakedAleska/Toolblox";
const headers = { Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }) };

const privateKey = (name) => {
  const seed = Buffer.from(process.env[name] || "", "base64");
  if (seed.length !== 32) throw new Error(`${name} must be a base64 32-byte Ed25519 seed.`);
  return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
};

const download = async (url) => {
  const response = await fetch(url, { headers: { ...headers, Accept: "application/octet-stream" } });
  if (!response.ok) throw new Error(`Download failed with status ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
};

const writeSigned = (path, value, key) => {
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  writeFileSync(path, bytes);
  writeFileSync(`${path}.sig`, sign(null, bytes, key).toString("base64"));
};

const manifestKey = privateKey("MANIFEST_PRIVATE_KEY");
const catalogueKey = privateKey("CATALOGUE_PRIVATE_KEY");

const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, { headers });
if (!response.ok) throw new Error(`The latest release couldn't be read (status ${response.status}).`);
const release = await response.json();
const asset = (name) => {
  const found = release.assets.find((entry) => entry.name === name);
  if (!found) throw new Error(`Release ${release.tag_name} has no ${name} asset.`);
  return found;
};
const installer = release.assets.find((entry) => entry.name === UPDATER_INSTALLER) ?? asset(INSTALLER);
const version = release.tag_name.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Release tag ${release.tag_name} isn't a semantic version.`);

/** Returns the manifest entry for a release asset and its updater signature. */
const artifact = async (file, signatureFile) => ({
  url: file.browser_download_url,
  sha256: createHash("sha256").update(await download(file.url)).digest("hex"),
  signature: (await download(asset(signatureFile).url)).toString("utf8").trim(),
});
const platforms = { "windows-x86_64": await artifact(installer, `${INSTALLER}.sig`) };
const archive = release.assets.find((entry) => entry.name === MACOS_ARCHIVE);
if (archive) {
  const macos = await artifact(archive, `${MACOS_ARCHIVE}.sig`);
  platforms["darwin-aarch64"] = macos;
  platforms["darwin-x86_64"] = macos;
}
const now = Math.floor(Date.now() / 1000);
const publishedAt = now - CLOCK_ALLOWANCE;

rmSync("_site", { recursive: true, force: true });
cpSync("site/dist", "_site", { recursive: true });
mkdirSync("_site/updates", { recursive: true });
mkdirSync("_site/catalogue", { recursive: true });
writeFileSync("_site/.nojekyll", "");

writeSigned("_site/updates/stable.json", {
  schemaVersion: 1,
  channel: "stable",
  version,
  publishedAt,
  expiresAt: publishedAt + MANIFEST_LIFETIME,
  platforms,
}, manifestKey);
const entries = packageWidgets("widgets", "_site/catalogue", CATALOGUE_URL);
writeSigned("_site/catalogue/v1.json", { schemaVersion: 1, generatedAt: now, entries }, catalogueKey);

console.log(`Published manifest for ${version} (${Object.keys(platforms).join(", ")}) and ${entries.length} catalogue widgets.`);
