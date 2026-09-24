/**
 * Prints release notes: `node scripts/release-notes.mjs <version> <sha256>`.
 *
 * Lists `feat`, `fix`, and `perf` commit subjects since the previous tag under a fixed download
 * section, so every release explains which file to download.
 */
import { execFileSync } from "node:child_process";

const [version, sha256] = process.argv.slice(2);
if (!version || !/^[0-9a-f]{64}$/.test(sha256 || "")) {
  console.error("Usage: node scripts/release-notes.mjs <version> <sha256>");
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

### ⬇️ [Download Toolblox-Setup.exe](https://github.com/BakedAleska/Toolblox/releases/download/v${version}/Toolblox-Setup.exe) (Windows 10 and 11)

Open the installer and follow the steps. If Windows shows "Windows protected your PC", select **More info**, then **Run anyway**. Toolblox isn't code-signed yet.

Installed copies update themselves the next time they open.

> [!IMPORTANT]
> **Toolblox-Setup.exe is the only file you need.** "Source code (zip)" and "Source code (tar.gz)" are added by GitHub automatically and don't contain the app. \`Toolblox-Setup.exe.sig\` is used by the updater.

## Changes

${sections.join("\n\n") || "Maintenance and internal changes."}

## Checksum

SHA-256 of \`Toolblox-Setup.exe\`: \`${sha256}\``);
