import { describe, expect, it } from "vitest";
import { SIDEBAR_COLLAPSED, SIDEBAR_MAX, SIDEBAR_MIN, clampSidebarWidth, failureReport, filterLog, opaqueSquare, logWidgets, matchAccount, newestFirst, parseJoinTarget, parsePlaceId, relativeTime, targetUserId, sortAccounts, stepSidebarWidth } from "./logic";
import type { Account } from "./types";

const account = (id: number, name: string, addedAt: number, lastPlayedAt?: number): Account => ({
  id,
  name,
  displayName: name,
  notes: "",
  addedAt,
  lastPlayedAt,
  presence: "offline",
});

describe("relativeTime", () => {
  it("accepts Unix seconds and JavaScript milliseconds", () => {
    const now = 1_800_000_000_000;
    expect(relativeTime(1_799_999_880, now)).toBe("Last played 2m ago");
    expect(relativeTime(1_799_999_880_000, now)).toBe("Last played 2m ago");
  });
});

describe("sortAccounts", () => {
  it("keeps manual order and sorts the other supported modes", () => {
    const accounts = [account(1, "Zulu", 1), account(2, "Alpha", 2, 3)];
    expect(sortAccounts(accounts, "manual").map(({ id }) => id)).toEqual([1, 2]);
    expect(sortAccounts(accounts, "alphabetical").map(({ id }) => id)).toEqual([2, 1]);
    expect(sortAccounts(accounts, "last_played").map(({ id }) => id)).toEqual([2, 1]);
  });
});

describe("matchAccount", () => {
  const farmer = { ...account(1, "builderman_alt", 0), displayName: "Builder", notes: "Main farming account" };
  it("matches every word across names and notes in any order", () => {
    expect(matchAccount(farmer, "builder")).toBe("name");
    expect(matchAccount(farmer, "ALT build")).toBe("name");
    expect(matchAccount(farmer, "farm main")).toBe("notes");
    expect(matchAccount(farmer, "builder farming")).toBe("notes");
    expect(matchAccount(farmer, "  ")).toBe("name");
  });
  it("rejects a query with any missing word", () => {
    expect(matchAccount(farmer, "builder trading")).toBe(false);
  });
});

describe("parseJoinTarget", () => {
  it("reads players from @ and a user ID or a profile link", () => {
    expect(parseJoinTarget(" @156 ")).toBe("@156");
    expect(parseJoinTarget("https://www.roblox.com/users/156/profile")).toBe("@156");
    expect(parseJoinTarget("roblox.com/users/156")).toBe("@156");
    expect(targetUserId("@156")).toBe(156);
    expect(targetUserId("1818")).toBeUndefined();
  });
  it("keeps place parsing and rejects usernames and invalid IDs", () => {
    expect(parseJoinTarget("1818")).toBe("1818");
    expect(parseJoinTarget("https://www.roblox.com/games/1818/x")).toBe("1818");
    for (const input of ["@builderman", "@", "@0", "@1 2", "https://www.roblox.com/users/x/profile", "https://example.com/users/156"]) expect(parseJoinTarget(input)).toBeUndefined();
  });
});

describe("parsePlaceId", () => {
  it("accepts numeric IDs and Roblox game URLs only", () => {
    expect(parsePlaceId("1818")).toBe("1818");
    expect(parsePlaceId("https://www.roblox.com/games/1818/Classic-Crossroads")).toBe("1818");
    expect(parsePlaceId("words 1818")).toBeUndefined();
    expect(parsePlaceId("https://example.com/games/1818")).toBeUndefined();
    expect(parsePlaceId("https://roblox.com/users/1818")).toBeUndefined();
    expect(parsePlaceId("roblox.com/games/1818/Classic-Crossroads")).toBe("1818");
    expect(parsePlaceId("http://web.roblox.com/games/1818")).toBe("1818");
    expect(parsePlaceId("https://www.roblox.com/games/start?placeId=1818")).toBe("1818");
    expect(parsePlaceId("https://roblox.com.example.com/games/1818")).toBeUndefined();
    expect(parsePlaceId("https://evilroblox.com/games/1818")).toBeUndefined();
    expect(parsePlaceId("javascript:alert(1818)")).toBeUndefined();
  });
});

describe("sidebar width", () => {
  it("snaps narrow drags to icon-only and clamps wide ones", () => {
    expect(clampSidebarWidth(80)).toBe(SIDEBAR_COLLAPSED);
    expect(clampSidebarWidth(130)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(250.4)).toBe(250);
    expect(clampSidebarWidth(900)).toBe(SIDEBAR_MAX);
  });

  it("steps across the collapsed threshold with the keyboard", () => {
    expect(stepSidebarWidth(SIDEBAR_COLLAPSED, true)).toBe(SIDEBAR_MIN);
    expect(stepSidebarWidth(SIDEBAR_MIN, false)).toBe(SIDEBAR_COLLAPSED);
    expect(stepSidebarWidth(SIDEBAR_MAX, true)).toBe(SIDEBAR_MAX);
    expect(stepSidebarWidth(200, true)).toBe(216);
  });
});

describe("newestFirst", () => {
  it("reverses records and keeps continuation lines under their record", () => {
    expect(newestFirst("a\nb\n  b2\n  b3\nc")).toBe("c\nb\n  b2\n  b3\na");
    expect(newestFirst("")).toBe("");
  });
});

describe("filterLog", () => {
  const log = [
    "2026-09-24T18:02:11.412Z INFO  toolblox: starting",
    "2026-09-24T18:02:12.000Z INFO  widget:rogue_lineage: Mana bar found",
    "  continued",
    "2026-09-24T18:02:13.000Z WARN  interface: Text with widget:rogue_lineage: inside",
    "2026-09-24T18:02:14.000Z WARN  widget:trade_tracker: Request failed",
  ].join("\n");

  it("keeps one widget's records with their continuation lines", () => {
    expect(filterLog(log, "rogue_lineage")).toBe("2026-09-24T18:02:12.000Z INFO  widget:rogue_lineage: Mana bar found\n  continued");
  });

  it("keeps Toolblox's own records, including messages that mention a widget", () => {
    expect(filterLog(log, "app").split("\n")).toEqual([
      "2026-09-24T18:02:11.412Z INFO  toolblox: starting",
      "2026-09-24T18:02:13.000Z WARN  interface: Text with widget:rogue_lineage: inside",
    ]);
  });

  it("keeps everything for all sources and nothing for an unknown one", () => {
    expect(filterLog(log, "all")).toBe(log);
    expect(filterLog(log, "missing")).toBe("");
    expect(filterLog("", "app")).toBe("");
  });

  it("lists the widgets that wrote to the log", () => {
    expect(logWidgets(log)).toEqual(["rogue_lineage", "trade_tracker"]);
  });
});

describe("failureReport", () => {
  it("puts the version, platform, and error above the recent log", () => {
    expect(failureReport("Join failed. Is Roblox installed?", "0.4.8-beta", "macOS", "line one\nline two\n")).toBe(
      "Toolblox 0.4.8-beta on macOS\nError: Join failed. Is Roblox installed?\n\nRecent log:\nline one\nline two");
    expect(failureReport("Oops.", "1.0.0", "Windows", "  ")).toMatch(/Recent log:\nThe log is empty\.$/);
  });
});

describe("opaqueSquare", () => {
  const pixels = (width: number, height: number, opaque: [number, number][]) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (const [x, y] of opaque) data[(y * width + x) * 4 + 3] = 255;
    return data;
  };

  it("fits a square around the visible pixels, centred on them", () => {
    expect(opaqueSquare(pixels(10, 10, [[4, 2], [5, 7]]), 10, 10)).toEqual([2, 2, 6]);
    expect(opaqueSquare(pixels(4, 4, [[0, 0], [3, 3]]), 4, 4)).toEqual([0, 0, 4]);
  });

  it("returns nothing for a fully transparent image", () => {
    expect(opaqueSquare(pixels(4, 4, []), 4, 4)).toBeUndefined();
  });
});
