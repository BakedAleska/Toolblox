import { describe, expect, it } from "vitest";
import { compareVersions, inline, parseChangelog, releases } from "@/changelog";

describe("changelog", () => {
  it("parses the title, date, headings, bullets, and separators", () => {
    const release = parseChangelog("0.4.8-beta", "# Toolblox 0.4.8 beta\n*Unreleased*\n\n## New\n- **Join** a player\n- Second\n\n---\n\n## Changes\nA paragraph\ncontinued.\n");
    expect(release.title).toBe("0.4.8 beta");
    expect(release.date).toBe("Unreleased");
    expect(release.sections).toEqual([
      [{ kind: "heading", level: 2, text: "New" }, { kind: "list", items: ["**Join** a player", "Second"] }],
      [{ kind: "heading", level: 2, text: "Changes" }, { kind: "text", text: "A paragraph continued." }],
    ]);
  });

  it("splits bold and italic runs and leaves stray markers", () => {
    expect(inline("Press **Join**, then *wait*. 2 * 3")).toEqual([
      { text: "Press " }, { text: "Join", bold: true }, { text: ", then " }, { text: "wait", italic: true }, { text: ". 2 * 3" },
    ]);
  });

  it("orders versions newest first with prereleases below the release", () => {
    expect(["0.4.8-beta", "0.4.10-beta", "0.4.10", "0.3.0-beta"].sort(compareVersions)).toEqual(["0.4.10", "0.4.10-beta", "0.4.8-beta", "0.3.0-beta"]);
  });

  it("bundles every changelog file with a title and content", () => {
    expect(releases.length).toBeGreaterThan(0);
    for (const release of releases) {
      expect(release.title).not.toBe(release.version);
      expect(release.sections.length).toBeGreaterThan(0);
    }
  });
});
