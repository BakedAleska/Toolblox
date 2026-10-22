import { describe, expect, it } from "vitest";
import { activeFilters, applyInput, commitDraft, emptySearch, matchAccount, resolveMacros, suggest } from "./search";
import type { Account } from "./types";

const account = (id: number, name: string, extra: Partial<Account> = {}): Account => ({ id, name, displayName: name, notes: "", addedAt: 0, presence: "offline", ...extra });
const accounts = [
  account(25122, "L0rses", { displayName: "Lorses", presence: "playing", gameName: "Classic: Crossroads", gamePlaceId: 1818 }),
  account(9001, "builder", { notes: "main alt", placeId: "21242" }),
  account(25199, "other", { lastPlaceId: "606849621" }),
];
const app = { accounts, recentPlaces: [{ placeId: "606849621", name: "Jailbreak" }] };
const visible = (text: string) => accounts.filter((item) => matchAccount(item, activeFilters(applyInput(emptySearch, text)), app)).map(({ id }) => id);

describe("filter keys", () => {
  it("resolves prefixes, aliases, and typos", () => {
    expect(resolveMacros("g")[0].key).toBe("game");
    expect(resolveMacros("nots")[0].key).toBe("note");
    expect(resolveMacros("playing")[0].key).toBe("game");
    expect(resolveMacros("n").map(({ key }) => key)).toEqual(["note"]);
    expect(resolveMacros("zzz")).toEqual([]);
  });

  it("opens a corrected filter when a colon is typed", () => {
    expect(applyInput(emptySearch, "#gme:")).toEqual({ filters: [], draft: "game", text: "" });
    expect(applyInput(emptySearch, "#zzz:")).toEqual({ filters: [], text: "#zzz:" });
  });

  it("splits pasted filters and keeps spaces where values allow them", () => {
    expect(applyInput(emptySearch, "#last:7d foo")).toEqual({ filters: [{ key: "last", value: "7d" }], text: "foo" });
    expect(applyInput(emptySearch, "L0 #game:Classic Cross")).toEqual({ filters: [{ key: "name", value: "L0" }], draft: "game", text: "Classic Cross" });
    expect(applyInput(emptySearch, "#game:Jail break #last:7")).toEqual({ filters: [{ key: "game", value: "Jail break" }], draft: "last", text: "7" });
  });

  it("commits the filter being typed", () => {
    expect(commitDraft({ filters: [], draft: "last", text: " 1d " })).toEqual({ filters: [{ key: "last", value: "1d" }], text: "" });
    expect(commitDraft({ filters: [], draft: "last", text: "" })).toEqual({ filters: [], draft: "last", text: "" });
  });
});

describe("matching", () => {
  it("treats plain text as a name filter", () => {
    expect(visible("lor")).toEqual([25122]);
    expect(visible("#")).toEqual([25122, 9001, 25199]);
  });

  it("matches each filter kind", () => {
    expect(visible("#game:jail")).toEqual([25199]);
    expect(visible("#note:alt")).toEqual([9001]);
  });

  it("requires every kind and any value of a repeated kind", () => {
    expect(visible("er #note:alt")).toEqual([9001]);
    expect(visible("er #game:jail")).toEqual([25199]);
    expect(visible("#game:jail #game:classic ")).toEqual([25122, 25199]);
  });
});

describe("suggestions", () => {
  it("suggests filters only after a #", () => {
    expect(suggest(emptySearch, app)).toBeUndefined();
    expect(suggest({ filters: [{ key: "game", value: "jail" }], text: " " }, app)).toBeUndefined();
    expect(suggest(applyInput(emptySearch, "#"), app)?.title).toBe("Filters");
  });

  it("completes account names from plain text", () => {
    const result = suggest(applyInput(emptySearch, "L0"), app);
    expect(result?.items[0].label).toBe("L0rses");
    expect(result?.items[0].apply).toEqual({ filters: [], text: "L0rses" });
  });

  it("completes filter keys, correcting typos", () => {
    expect(suggest(applyInput(emptySearch, "#g"), app)?.items[0].apply).toEqual({ filters: [], draft: "game", text: "" });
    expect(suggest(applyInput(emptySearch, "#gme"), app)?.items[0].label).toBe("#game:");
    expect(suggest(applyInput(emptySearch, "lor #la"), app)?.items[0].apply).toEqual({ filters: [{ key: "name", value: "lor" }], draft: "last", text: "" });
    expect(suggest(applyInput(emptySearch, "#"), app)?.items.map(({ id }) => id)).toEqual(["game", "last", "note"]);
  });

  it("suggests values inside a filter", () => {
    expect(suggest(applyInput(emptySearch, "#game:j"), app)?.items.map(({ label }) => label)).toEqual(["Jailbreak"]);
    expect(suggest(applyInput(emptySearch, "#last:"), app)?.items.map(({ label }) => label)).toEqual(["1h", "1d", "7d", "30d", "never"]);
  });
});

describe("last played", () => {
  const now = 1_800_000_000_000;
  const timed = [
    account(1, "recent", { lastPlayedAt: (now - 2 * 3_600_000) / 1000 }),
    account(2, "week", { lastPlayedAt: now - 5 * 86_400_000 }),
    account(3, "never"),
  ];
  const shown = (text: string) =>
    timed.filter((item) => matchAccount(item, activeFilters(applyInput(emptySearch, text)), { recentPlaces: [], now })).map(({ id }) => id);

  it("filters by when an account last played", () => {
    expect(shown("#last:1d")).toEqual([1]);
    expect(shown("#last:1w")).toEqual([1, 2]);
    expect(shown("#last:3")).toEqual([1]);
    expect(shown("#last:never")).toEqual([3]);
    expect(shown("#last:soon")).toEqual([]);
  });
});
