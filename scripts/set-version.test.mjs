import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve("scripts/set-version.mjs");
let dir;
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
const write = (path, text) => writeFileSync(join(dir, path), text);
const read = (path) => readFileSync(join(dir, path), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "set-version-"));
  mkdirSync(join(dir, "changelogs"));
  mkdirSync(join(dir, "src-tauri"));
  write("package.json", '{ "version": "1.0.0" }');
  write("package-lock.json", '{ "version": "1.0.0", "packages": { "": { "version": "1.0.0" } } }');
  write("src-tauri/tauri.conf.json", '{ "version": "1.0.0" }');
  write("src-tauri/Cargo.toml", 'version = "1.0.0"\n');
  write("src-tauri/Cargo.lock", 'name = "toolblox"\nversion = "1.0.0"\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("set-version", () => {
  it("dates the changelog, including one with CRLF line endings", () => {
    write("changelogs/1.1.0.md", "# Toolblox 1.1.0\r\n*Unreleased*\r\n\r\n- New.\r\n");
    expect(run("--check", "1.1.0").status).toBe(0);
    expect(run("1.1.0").status).toBe(0);
    const date = new Date().toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" });
    expect(read("changelogs/1.1.0.md")).toBe(`# Toolblox 1.1.0\r\n*${date}*\r\n\r\n- New.\r\n`);
    expect(JSON.parse(read("package.json")).version).toBe("1.1.0");
  });

  it("rejects a missing or already dated changelog", () => {
    expect(run("--check", "1.1.0").stderr).toMatch(/must exist/);
    write("changelogs/1.1.0.md", "# Toolblox 1.1.0\n*October 1, 2026*\n");
    expect(run("--check", "1.1.0").status).toBe(1);
  });

  it("changes nothing when there's no changelog to date", () => {
    expect(run("1.1.0").status).not.toBe(0);
    expect(JSON.parse(read("package.json")).version).toBe("1.0.0");
  });
});
