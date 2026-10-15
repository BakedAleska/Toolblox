import type { Account, AppState } from "./types";

/** Account search with `#key:value` filters. Plain text filters by name. */

export type SearchKey = "name" | "game" | "last" | "note";

export type Filter = { key: SearchKey; value: string };

/** Committed filters, the filter being typed (`draft`), and the text in the field. */
export type SearchState = { filters: Filter[]; draft?: SearchKey; text: string };

export const emptySearch: SearchState = { filters: [], text: "" };

export type Macro = {
  key: SearchKey;
  aliases: string[];
  description: string;
  placeholder: string;
  /** Values may contain spaces, so a space doesn't end the filter. */
  spaces: boolean;
  /** Fixed values the filter suggests. */
  values?: { value: string; label: string }[];
};

/** Plain text filters by name. It has a chip but isn't offered as a `#key:`. */
const nameMacro: Macro = { key: "name", aliases: [], description: "Username or display name", placeholder: "name", spaces: true };

export const macros: Macro[] = [
  { key: "game", aliases: ["playing"], description: "Game name", placeholder: "game", spaces: true },
  { key: "last", aliases: ["played", "lastplayed"], description: "Last played within a time, or never", placeholder: "7d", spaces: false,
    values: [{ value: "1h", label: "Within an hour" }, { value: "1d", label: "Within a day" }, { value: "7d", label: "Within a week" }, { value: "30d", label: "Within 30 days" }, { value: "never", label: "Never played" }] },
  { key: "note", aliases: ["notes"], description: "Text in the account's note", placeholder: "text", spaces: true },
];

export const macroFor = (key: SearchKey) => key === "name" ? nameMacro : macros.find((macro) => macro.key === key)!;

/** Optimal string alignment distance: edits, with adjacent swaps counted once. */
const distance = (a: string, b: string) => {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
};

/** Filters matching a typed key, best first: exact names, then prefixes, then close typos. */
export const resolveMacros = (typed: string): Macro[] => {
  const query = typed.toLowerCase();
  if (!query) return macros;
  const allowed = query.length >= 5 ? 2 : query.length >= 2 ? 1 : 0;
  return macros
    .map((macro, order) => {
      const names = [macro.key, ...macro.aliases];
      if (names.includes(query)) return { macro, order, score: 0 };
      if (macro.key.startsWith(query)) return { macro, order, score: 1 };
      if (macro.aliases.some((name) => name.startsWith(query))) return { macro, order, score: 1.5 };
      const typo = Math.min(...names.map((name) => Math.min(distance(query, name), distance(query, name.slice(0, query.length)))));
      return { macro, order, score: typo <= allowed ? 2 + typo : Infinity };
    })
    .filter(({ score }) => score < Infinity)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map(({ macro }) => macro);
};

/** The first `#key:` in the text. */
const findToken = (text: string) => {
  for (const match of text.matchAll(/(^|\s)#([a-z]+):/gi)) {
    const macro = resolveMacros(match[2])[0];
    if (macro) return { index: match.index, end: match.index + match[0].length, macro };
  }
};

/** Applies new field text: a typed `#key:` (corrected when misspelled) opens a filter, and a space
 * ends a filter whose values can't contain one. Pasted text with several filters is split. */
export const applyInput = (state: SearchState, input: string): SearchState => {
  const filters = [...state.filters];
  let draft = state.draft;
  let rest = input;
  for (;;) {
    if (draft) {
      const cut = macroFor(draft).spaces ? rest.search(/\s#[a-z]+:/i) : rest.indexOf(" ");
      if (cut < 0) return { filters, draft, text: rest };
      const value = rest.slice(0, cut).trim();
      if (value) filters.push({ key: draft, value });
      draft = undefined;
      rest = rest.slice(cut).trimStart();
      continue;
    }
    const token = findToken(rest);
    if (!token) return { filters, text: rest };
    const before = rest.slice(0, token.index).trim();
    if (before) filters.push({ key: "name", value: before });
    rest = rest.slice(token.end);
    draft = token.macro.key;
  }
};

/** Turns the filter being typed into a committed one. */
export const commitDraft = (state: SearchState): SearchState => {
  const value = state.text.trim();
  if (!state.draft || !value) return state;
  return { filters: [...state.filters, { key: state.draft, value }], text: "" };
};

/** Every filter in effect, including the one being typed and plain text. */
export const activeFilters = (state: SearchState): Filter[] => {
  const text = state.text.trim();
  if (!text) return state.filters;
  if (state.draft) return [...state.filters, { key: state.draft, value: text }];
  return text.startsWith("#") ? state.filters : [...state.filters, { key: "name", value: text }];
};

/** What matching needs beyond the account: place names and the time. */
type Places = Pick<AppState, "recentPlaces"> & { now?: number };

const toMilliseconds = (timestamp: number) => (timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);
const units = { h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/** `never`, or a window such as `3d`, `12h`, or `2w`. A bare number means days. */
const playedWithin = (account: Account, query: string, now: number) => {
  if (query.length >= 2 && "never".startsWith(query)) return !account.lastPlayedAt;
  const window = /^(\d+)\s*([hdw]?)$/.exec(query);
  if (!window) return false;
  return !!account.lastPlayedAt && now - toMilliseconds(account.lastPlayedAt) <= Number(window[1]) * units[(window[2] || "d") as keyof typeof units];
};

const placeName = (state: Places, placeId?: string) => (placeId && state.recentPlaces.find((place) => place.placeId === placeId)?.name) || "";

const matches = (account: Account, { key, value }: Filter, state: Places) => {
  const query = value.toLowerCase();
  switch (key) {
    case "name": return `${account.name}\n${account.displayName}`.toLowerCase().includes(query);
    case "game": return [account.gameName, placeName(state, account.lastPlaceId), placeName(state, account.placeId)].some((name) => name?.toLowerCase().includes(query));
    case "note": return account.notes.toLowerCase().includes(query);
    case "last": return playedWithin(account, query, state.now ?? Date.now());
  }
};

/** Filters of different kinds must all match. Repeated kinds match when any value does. */
export const matchAccount = (account: Account, filters: Filter[], state: Places) => {
  const byKey = new Map<SearchKey, Filter[]>();
  for (const filter of filters) byKey.set(filter.key, [...(byKey.get(filter.key) ?? []), filter]);
  return [...byKey.values()].every((group) => group.some((filter) => matches(account, filter, state)));
};

export type Suggestion = { id: string; label: string; detail?: string; mono?: boolean; apply: SearchState };
export type Suggestions = { title: string; items: Suggestion[] };

const LIMIT = 8;

/** Ranks prefix matches before matches elsewhere in the text. */
const rank = <T,>(items: T[], query: string, text: (item: T) => string[]) => {
  const q = query.toLowerCase();
  return items
    .map((item) => {
      const values = text(item).map((value) => value.toLowerCase());
      return { item, score: !q ? 1 : values.some((value) => value.startsWith(q)) ? 0 : values.some((value) => value.includes(q)) ? 1 : Infinity };
    })
    .filter(({ score }) => score < Infinity)
    .sort((a, b) => a.score - b.score)
    .map(({ item }) => item);
};

/** Suggestions for the field's current text. */
export const suggest = (state: SearchState, app: Pick<AppState, "accounts" | "recentPlaces">): Suggestions | undefined => {
  const { filters, draft, text } = state;
  const used = (key: SearchKey, value: string) => filters.some((filter) => filter.key === key && filter.value.toLowerCase() === value.toLowerCase());
  const commit = (key: SearchKey, value: string): SearchState => ({ filters: [...filters, { key, value }], text: "" });

  if (draft) {
    const query = text.trim();
    const macro = macroFor(draft);
    let items: Suggestion[] = [];
    if (macro.values) {
      items = rank(macro.values, query, (option) => [option.value, option.label]).map((option) => ({ id: option.value, label: option.value, detail: option.label, apply: commit(draft, option.value) }));
    } else if (draft === "name") {
      items = rank(app.accounts, query, (account) => [account.name, account.displayName]).map((account) => ({ id: String(account.id), label: account.name, detail: account.displayName !== account.name ? account.displayName : undefined, apply: commit(draft, account.name) }));
    } else if (draft === "game") {
      const names = new Set([...app.accounts.map((account) => account.gameName), ...app.recentPlaces.map((place) => place.name)].filter((name): name is string => !!name));
      items = rank([...names], query, (name) => [name]).map((name) => ({ id: name, label: name, apply: commit(draft, name) }));
    }
    items = items.filter((item) => !used(draft, item.label));
    return items.length ? { title: macro.description, items: items.slice(0, LIMIT) } : undefined;
  }

  const typing = /(^|\s)#([a-z]*)$/i.exec(text);
  if (typing) {
    const typed = typing[2];
    const before = text.slice(0, typing.index);
    const items = resolveMacros(typed)
      .map((macro) => ({ id: macro.key, label: `#${macro.key}:`, detail: macro.description, mono: true, apply: applyInput({ filters, text: "" }, `${before.trim()} #${macro.key}:`.trimStart()) }));
    return items.length ? { title: "Filters", items } : undefined;
  }

  const query = text.trim();
  if (!query) return undefined;
  const items = rank(app.accounts, query, (account) => [account.name, account.displayName])
    .map((account) => {
      const fill = account.displayName.toLowerCase().startsWith(query.toLowerCase()) ? account.displayName : account.name;
      return { id: String(account.id), label: fill, detail: fill === account.name ? (account.displayName !== account.name ? account.displayName : undefined) : `@${account.name}`, apply: { filters, text: fill } };
    })
    .filter((item) => item.label.toLowerCase() !== query.toLowerCase());
  return items.length ? { title: "Accounts", items: items.slice(0, LIMIT) } : undefined;
};
