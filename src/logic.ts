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

export const parsePlaceId = (input: string) => {
  const value = input.trim();
  if (/^\d+$/.test(value)) return value;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "roblox.com" && host !== "www.roblox.com")) return undefined;
    const match = url.pathname.match(/^\/games\/(\d+)(?:\/|$)/);
    return match?.[1];
  } catch {
    return undefined;
  }
};

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
