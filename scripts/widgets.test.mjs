import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageWidgets } from "./widgets.mjs";

const roots = [];
const manifest = { schemaVersion: 1, id: "sample", name: "Sample", version: "1.0.0", description: "A sample widget.", module: "main.js", permissions: ["widgetData.read"] };

/** Creates a widgets folder with one widget, overriding its manifest and files. */
function widgets(overrides = {}, files = { LICENSE: "MIT", "main.js": "export function activate() {}" }) {
  const root = mkdtempSync(join(tmpdir(), "toolblox-widgets-"));
  roots.push(root);
  const folder = join(root, "widgets", "sample");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "widget.json"), JSON.stringify({ ...manifest, ...overrides }));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(folder, name), content);
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("catalogue packaging", () => {
  it("builds reproducible packages and matching catalogue entries", () => {
    const root = widgets();
    const [entry] = packageWidgets(join(root, "widgets"), join(root, "out"), "https://toolblox.dev/catalogue/");
    expect(entry).toMatchObject({ id: "sample", version: "1.0.0", permissions: ["widgetData.read"], archiveUrl: "https://toolblox.dev/catalogue/sample/1.0.0/package.zip" });
    const first = readFileSync(join(root, "out/sample/1.0.0/package.zip"));
    const [again] = packageWidgets(join(root, "widgets"), join(root, "out2"), "https://toolblox.dev/catalogue/");
    expect(again.sha256).toBe(entry.sha256);
    expect(readFileSync(join(root, "out2/sample/1.0.0/package.zip")).equals(first)).toBe(true);
  });

  it("rejects widgets that can't be listed", () => {
    const pack = (root) => () => packageWidgets(join(root, "widgets"), join(root, "out"), "https://toolblox.dev/catalogue/");
    expect(pack(widgets({ id: "other" }))).toThrow("folder name");
    expect(pack(widgets({}, { "main.js": "" }))).toThrow("LICENSE");
    expect(pack(widgets({}, { LICENSE: "MIT" }))).toThrow("main.js is missing");
    expect(pack(widgets({ permissions: ["cookies.read"] }))).toThrow("known permission");
    expect(pack(widgets({ version: "1.0" }))).toThrow("SemVer");
  });

  it("returns no entries without a widgets folder", () => {
    expect(packageWidgets(join(tmpdir(), "toolblox-missing-widgets"), tmpdir(), "https://toolblox.dev/catalogue/")).toEqual([]);
  });
});
