/**
 * Prints release notes: `node scripts/release-notes.mjs <version> <windows sha256> <macos sha256>`.
 *
 * Lists `feat`, `fix`, and `perf` commit subjects since the previous tag under a fixed download
 * section, so every release explains which file to download.
 */
import { execFileSync } from "node:child_process";

const [version, windowsSha256, macosSha256] = process.argv.slice(2);
if (!version || ![windowsSha256, macosSha256].every((sha256) => /^[0-9a-f]{64}$/.test(sha256 || ""))) {
  console.error("Usage: node scripts/release-notes.mjs <version> <windows sha256> <macos sha256>");
  process.exit(1);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
let previous = "";
try { previous = git("describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD^"); } catch { /* first release */ }
const subjects = git("log", "--format=%s", previous ? `${previous}..HEAD` : "HEAD").split("\n");

const sections = [["feat", "Features"], ["fix", "Fixes"], ["perf", "Performance"]].map(([type, title]) => {
  const items = subjects
    .map((subject) => subject.match(new RegExp(`^${type}(?:\\(([^)]+)\\))?!?: (.+)$`)))
    .filter(Boolean)
    .map(([, scope, text]) => `- ${text.charAt(0).toUpperCase()}${text.slice(1)}${scope ? ` (${scope})` : ""}`);
  return items.length ? `### ${title}\n\n${items.join("\n")}` : "";
}).filter(Boolean);

console.log(`## Download

### ⬇️ [Download Toolblox from toolblox.dev](https://toolblox.dev/#download)

For Windows 10 and 11, and macOS on Apple silicon and Intel. Installed copies update themselves the next time they open.

- **Windows**: if Windows shows "Windows protected your PC", select **More info**, then **Run anyway**. Toolblox isn't code-signed yet.
- **macOS**: the first time Toolblox opens, macOS says it can't verify the developer. Select **Done**, then open **System Settings → Privacy & Security** and select **Open Anyway**. Toolblox isn't notarized yet.

> [!IMPORTANT]
> The files below are used by the installer and updater, so download Toolblox from [toolblox.dev](https://toolblox.dev/#download) instead. "Source code (zip)" and "Source code (tar.gz)" are added by GitHub automatically and don't contain the app.

## Changes

${sections.join("\n\n") || "Maintenance and internal changes."}

## Checksums

- SHA-256 of \`Toolblox-Setup.exe\`: \`${windowsSha256}\`
- SHA-256 of \`Toolblox.dmg\`: \`${macosSha256}\``);
