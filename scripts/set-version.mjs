/**
 * Sets the app version everywhere it's declared: `node scripts/set-version.mjs 0.3.0-beta`.
 * With `--check`, only verifies that the version is newer than the current one.
 *
 * The startup update check compares the Cargo version with the signed manifest, so every file
 * must agree.
 */
import { readFileSync, writeFileSync } from "node:fs";

const check = process.argv[2] === "--check";
const version = process.argv[check ? 3 : 2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/set-version.mjs [--check] <semver>");
  process.exit(1);
}

/** Orders versions by SemVer precedence: a release is newer than its prereleases. */
const compare = (a, b) => {
  const [coreA, preA] = a.split(/-(.*)/), [coreB, preB] = b.split(/-(.*)/);
  const numbers = coreA.split(".").map((part, index) => Number(part) - Number(coreB.split(".")[index])).find(Boolean);
  if (numbers) return numbers;
  if (!preA || !preB) return preA ? -1 : preB ? 1 : 0;
  return preA.localeCompare(preB, "en", { numeric: true });
};

if (check) {
  const current = JSON.parse(readFileSync("package.json", "utf8")).version;
  if (compare(version, current) <= 0) {
    console.error(`${version} must be newer than ${current}.`);
    process.exit(1);
  }
  process.exit(0);
}

const replace = (path, pattern, value) => {
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) throw new Error(`No version found in ${path}.`);
  writeFileSync(path, text.replace(pattern, value));
};
const json = (path, update) => {
  const value = JSON.parse(readFileSync(path, "utf8"));
  update(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

json("package.json", (value) => { value.version = version; });
json("package-lock.json", (value) => { value.version = version; value.packages[""].version = version; });
json("src-tauri/tauri.conf.json", (value) => { value.version = version; });
replace("src-tauri/Cargo.toml", /^version = ".*"$/m, `version = "${version}"`);
replace("src-tauri/Cargo.lock", /(name = "toolblox"\r?\nversion = )".*"/, `$1"${version}"`);
replace("src/bridge.ts", /(\n  version: )".*",/, `$1"${version}",`);

console.log(`Version set to ${version}.`);
