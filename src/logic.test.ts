import { describe, expect, it } from "vitest";
import { SIDEBAR_COLLAPSED, SIDEBAR_MAX, SIDEBAR_MIN, clampSidebarWidth, parsePlaceId, relativeTime, sortAccounts, stepSidebarWidth } from "./logic";
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
  it("accepts legacy Unix seconds and JavaScript milliseconds", () => {
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

describe("parsePlaceId", () => {
  it("accepts numeric IDs and Roblox game URLs only", () => {
    expect(parsePlaceId("1818")).toBe("1818");
    expect(parsePlaceId("https://www.roblox.com/games/1818/Classic-Crossroads")).toBe("1818");
    expect(parsePlaceId("words 1818")).toBeUndefined();
    expect(parsePlaceId("https://example.com/games/1818")).toBeUndefined();
    expect(parsePlaceId("https://roblox.com/users/1818")).toBeUndefined();
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
