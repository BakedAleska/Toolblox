/** A GitHub release, reduced to the fields the bot reads. */
export interface Release {
  tag_name: string;
  html_url: string;
  draft: boolean;
  assets: { name: string; download_count: number }[];
}

/** A platform whose installer downloads are counted. */
export type Kind = "windows" | "macos";

/** Installer download counts per platform. */
export type Totals = Record<Kind, number>;

/** Display names for each platform, in display order. */
const LABELS: [Kind, string][] = [
  ["windows", "Windows"],
  ["macos", "macOS"],
];

/** GitHub releases endpoint for the Toolblox repository. */
const RELEASES_URL = "https://api.github.com/repos/BakedAleska/Toolblox/releases?per_page=100";

/** Fetches every release. A token raises GitHub's rate limit and is optional. */
export async function fetchReleases(token?: string): Promise<Release[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "toolblox-bot",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(RELEASES_URL, { headers });
  if (!response.ok) throw new Error(`GitHub returned status ${response.status} for releases.`);
  return response.json();
}

/** Returns the newest published release. */
export function latestRelease(releases: Release[]): Release | undefined {
  return releases.find((release) => !release.draft);
}

/**
 * Sums installer downloads per platform across every release, the same count the website shows.
 * Updates aren't counted. Windows installers are counted only from releases with a separate
 * `Toolblox-Update.exe`, because before 0.3.0 the updater also downloaded the installer.
 */
export function countDownloads(releases: Release[]): Totals {
  const totals: Totals = { windows: 0, macos: 0 };
  for (const release of releases) {
    const separateUpdater = release.assets.some((asset) => asset.name === "Toolblox-Update.exe");
    for (const asset of release.assets) {
      if (asset.name === "Toolblox.dmg") totals.macos += asset.download_count;
      if (asset.name === "Toolblox-Setup.exe" && separateUpdater) totals.windows += asset.download_count;
    }
  }
  return totals;
}

/** Returns how much each platform grew since `previous`, or null when none grew. */
export function downloadIncrease(previous: Totals, current: Totals): Totals | null {
  const increase: Totals = { windows: 0, macos: 0 };
  let grew = false;
  for (const [kind] of LABELS) {
    increase[kind] = Math.max(0, current[kind] - (previous[kind] ?? 0));
    if (increase[kind] > 0) grew = true;
  }
  return grew ? increase : null;
}

/**
 * Returns the higher count for each platform. Download counts only grow, so a lower count is a
 * bad GitHub response and isn't saved; otherwise the next good response reports every download
 * again.
 */
export function highestTotals(previous: Totals, current: Totals): Totals {
  const highest: Totals = { windows: 0, macos: 0 };
  for (const [kind] of LABELS) highest[kind] = Math.max(previous[kind] ?? 0, current[kind]);
  return highest;
}

/** Formats counts as a total and its split, such as `12 (Windows 7, macOS 5)`. */
export function formatTotals(totals: Totals, sign = ""): string {
  const sum = LABELS.reduce((total, [kind]) => total + totals[kind], 0);
  const split = LABELS.map(([kind, label]) => `${label} ${sign}${totals[kind]}`).join(", ");
  return `${sign}${sum} (${split})`;
}

/** Formats a download notification. */
export function formatIncrease(increase: Totals, current: Totals): string {
  return `New downloads: ${formatTotals(increase, "+")}\nTotal: ${formatTotals(current)}`;
}

/** Formats a release tag for display, such as `0.3.1 beta` for `v0.3.1-beta`. */
export function formatVersion(tag: string): string {
  return tag.replace(/^v/, "").replace("-", " ");
}
