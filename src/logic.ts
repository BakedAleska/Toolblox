import type { Account, SortOrder } from "./types";

export const accountName = (account: Account) => account.displayName || account.name;

export const relativeTime = (timestamp?: number, now = Date.now()) => {
  if (!timestamp) return "Never played";
  const milliseconds = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  const seconds = Math.max(0, (now - milliseconds) / 1000);
  if (seconds < 60) return "Last played just now";
  if (seconds < 3600) return `Last played ${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `Last played ${Math.floor(seconds / 3600)}h ago`;
  return `Last played ${Math.floor(seconds / 86400)}d ago`;
};

export const sortAccounts = (accounts: Account[], order: SortOrder) =>
  order === "manual"
    ? [...accounts]
    : order === "alphabetical"
      ? [...accounts].sort((a, b) => accountName(a).localeCompare(accountName(b)))
      : [...accounts].sort((a, b) => (b.lastPlayedAt || b.addedAt) - (a.lastPlayedAt || a.addedAt));

/** Whether an account matches a search. Each word in `query` must appear, in any order and
 * ignoring case, in the display name, username, or notes. Returns `false` for no match, `"name"`
 * when the names match, and `"notes"` when the notes are needed. */
export const matchAccount = (account: Account, query: string): false | "name" | "notes" => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return "name";
  const names = `${account.displayName} ${account.name}`.toLowerCase();
  const all = `${names} ${account.notes.toLowerCase()}`;
  if (!words.every((word) => all.includes(word))) return false;
  return words.every((word) => names.includes(word)) ? "name" : "notes";
};

/** A place ID from a bare ID or a roblox.com link, with or without its scheme: `/games/<id>` paths
 * and `placeId=` query parameters. */
export const parsePlaceId = (input: string) => {
  const value = input.trim();
  if (/^\d+$/.test(value)) return value;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.toLowerCase();
    if ((url.protocol !== "https:" && url.protocol !== "http:") || (host !== "roblox.com" && !host.endsWith(".roblox.com"))) return undefined;
    const query = url.searchParams.get("placeId") ?? url.searchParams.get("placeid");
    if (query && /^\d+$/.test(query)) return query;
    return url.pathname.match(/^\/games\/(\d+)(?:\/|$)/)?.[1];
  } catch {
    return undefined;
  }
};

/** A join target from a place ID or game link, as `parsePlaceId` reads them, or a player as `@`
 * and a user ID, from `@<id>` or a roblox.com profile link. `@` and a username isn't a target
 * until the username is looked up. */
export const parseJoinTarget = (input: string) => {
  const value = input.trim();
  const id = value.startsWith("@") ? value.slice(1) : profileUserId(value);
  if (id !== undefined) return /^\d{1,20}$/.test(id) && !/^0+$/.test(id) ? `@${id}` : undefined;
  return parsePlaceId(value);
};

/** The user ID in a roblox.com `/users/<id>` link, an empty string for another `/users/` path,
 * or undefined for anything else. */
const profileUserId = (value: string) => {
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.toLowerCase();
    if ((url.protocol !== "https:" && url.protocol !== "http:") || (host !== "roblox.com" && !host.endsWith(".roblox.com"))) return undefined;
    const match = url.pathname.match(/^\/users\/([^/]*)/);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
};

/** The user ID of a player target, such as `@156`. */
export const targetUserId = (target?: string) => target?.startsWith("@") ? Number(target.slice(1)) : undefined;

export const SIDEBAR_COLLAPSED = 56;
export const SIDEBAR_MIN = 160;
export const SIDEBAR_MAX = 320;
export const SIDEBAR_DEFAULT = 192;

/** Snaps widths below the label threshold to the icon-only width and clamps the rest. */
export const clampSidebarWidth = (width: number) =>
  width < (SIDEBAR_COLLAPSED + SIDEBAR_MIN) / 2 ? SIDEBAR_COLLAPSED : Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));

/** Keyboard resizing: 16-pixel steps that cross between icon-only and the minimum labelled width. */
export const stepSidebarWidth = (width: number, grow: boolean) => {
  if (width === SIDEBAR_COLLAPSED) return grow ? SIDEBAR_MIN : SIDEBAR_COLLAPSED;
  const next = width + (grow ? 16 : -16);
  return next < SIDEBAR_MIN ? SIDEBAR_COLLAPSED : Math.min(SIDEBAR_MAX, next);
};

/** Splits a log into records, each with its indented continuation lines. */
const logRecords = (log: string) => {
  const records: string[] = [];
  for (const line of log.split("\n")) {
    if (/^\s/.test(line) && records.length) records[records.length - 1] += `\n${line}`;
    else records.push(line);
  }
  return records;
};

/** Reverses log records, keeping each record's indented continuation lines under it. */
export const newestFirst = (log: string) => logRecords(log).reverse().join("\n");

/** The ID of the widget that wrote a log record, from its target in the line format of `logs.rs`, or undefined for Toolblox's own. */
export const logWidget = (record: string) => /^\S+ [A-Z]+ +widget:([a-z0-9_]+): /.exec(record)?.[1];

/** The IDs of the widgets that wrote to a log, in order of their first record. */
export const logWidgets = (log: string) => [...new Set(logRecords(log).map(logWidget).filter((id) => id !== undefined))];

/** Keeps the log records from one source: "all", "app" for Toolblox's own, or a widget's ID. */
export const filterLog = (log: string, source: string) =>
  source === "all" ? log : logRecords(log).filter((record) => record && (logWidget(record) ?? "app") === source).join("\n");

/** The text "Copy logs" puts on the clipboard: the app version and platform, the error, and the recent log. */
export const failureReport = (error: string, version: string, platform: string, log: string) =>
  [`Toolblox ${version} on ${platform}`, `Error: ${error}`, "", "Recent log:", log.trim() || "The log is empty."].join("\n");

/** The smallest square, centred on the visible pixels of RGBA `data`, as `[x, y, size]`, or
 * undefined when every pixel is transparent. Used to crop the margin out of widget icons. */
export const opaqueSquare = (data: ArrayLike<number>, width: number, height: number): [number, number, number] | undefined => {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] < 8) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < 0) return undefined;
  const size = Math.max(right - left, bottom - top) + 1;
  return [(left + right + 1 - size) / 2, (top + bottom + 1 - size) / 2, size];
};
