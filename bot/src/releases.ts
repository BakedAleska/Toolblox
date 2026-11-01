/** A GitHub release, reduced to the fields the bot reads. */
export interface Release {
  tag_name: string;
  html_url: string;
  draft: boolean;
  assets: { name: string; download_count: number }[];
}

/** A platform whose downloads, users, and updates are counted. */
export type Kind = "windows" | "macos";

/** Counts per platform. */
export type Totals = Record<Kind, number>;

/** What the bot counts: installer downloads, first downloads from the website, and app updates. */
export type Metric = "downloads" | "users" | "updates";

/** Totals for each metric. */
export type Stats = Record<Metric, Totals>;

/** Display names for each platform, in display order. */
const LABELS: [Kind, string][] = [
  ["windows", "Windows"],
  ["macos", "macOS"],
];

/** Display names for each metric, in display order. */
const METRICS: [Metric, string][] = [
  ["downloads", "Downloads"],
  ["users", "Users"],
  ["updates", "Updates"],
];

/** Returns zero for every platform. */
export const emptyTotals = (): Totals => ({ windows: 0, macos: 0 });

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
 * Re-downloads count again. Updates aren't counted. Windows installers are counted only from
 * releases with a separate `Toolblox-Update.exe`, because before 0.3.0 the updater also downloaded
 * the installer.
 */
export function countDownloads(releases: Release[]): Totals {
  const totals = emptyTotals();
  for (const release of releases) {
    const separateUpdater = release.assets.some((asset) => asset.name === "Toolblox-Update.exe");
    for (const asset of release.assets) {
      if (asset.name === "Toolblox.dmg") totals.macos += asset.download_count;
      if (asset.name === "Toolblox-Setup.exe" && separateUpdater) totals.windows += asset.download_count;
    }
  }
  return totals;
}

/**
 * Sums required app updates per platform: downloads of `Toolblox-Update.exe` and
 * `Toolblox.app.tar.gz`. Releases without `SHA256SUMS` were also downloaded once per manifest
 * build, so those builds, counted by downloads of the matching `.sig`, are subtracted.
 */
export function countUpdates(releases: Release[]): Totals {
  const totals = emptyTotals();
  for (const release of releases) {
    const count = (name: string) => release.assets.find((asset) => asset.name === name)?.download_count ?? 0;
    const builds = (signature: string) => (release.assets.some((asset) => asset.name === "SHA256SUMS") ? 0 : count(signature));
    totals.windows += Math.max(0, count("Toolblox-Update.exe") - builds("Toolblox-Setup.exe.sig"));
    totals.macos += Math.max(0, count("Toolblox.app.tar.gz") - builds("Toolblox.app.tar.gz.sig"));
  }
  return totals;
}

/** Returns how much each platform grew since `previous`, or null when none grew. */
export function totalsIncrease(previous: Totals | undefined, current: Totals): Totals | null {
  const increase = emptyTotals();
  let grew = false;
  for (const [kind] of LABELS) {
    increase[kind] = Math.max(0, current[kind] - (previous?.[kind] ?? 0));
    if (increase[kind] > 0) grew = true;
  }
  return grew ? increase : null;
}

/**
 * Returns the higher count for each platform. Counts only grow, so a lower count is a bad
 * response and isn't saved; otherwise the next good response reports everything again.
 */
export function highestTotals(previous: Totals | undefined, current: Totals): Totals {
  const highest = emptyTotals();
  for (const [kind] of LABELS) highest[kind] = Math.max(previous?.[kind] ?? 0, current[kind]);
  return highest;
}

/** Compares counts with the last saved ones, returning each metric that grew and the totals to save. */
export function compareStats(previous: Partial<Stats>, current: Stats): { increases: Partial<Stats>; totals: Stats } {
  const increases: Partial<Stats> = {};
  const totals = {} as Stats;
  for (const [metric] of METRICS) {
    totals[metric] = highestTotals(previous[metric], current[metric]);
    const increase = totalsIncrease(previous[metric], current[metric]);
    if (increase) increases[metric] = increase;
  }
  return { increases, totals };
}

/** Formats counts as a total and its split, such as `12 (Windows 7, macOS 5)`. */
export function formatTotals(totals: Totals, sign = ""): string {
  const sum = LABELS.reduce((total, [kind]) => total + totals[kind], 0);
  const split = LABELS.map(([kind, label]) => `${label} ${sign}${totals[kind]}`).join(", ");
  return `${sign}${sum} (${split})`;
}

/** Formats one line per metric with its total, such as `Users: 3 (Windows 2, macOS 1)`. */
export function formatStats(stats: Stats): string {
  return METRICS.map(([metric, label]) => `${label}: ${formatTotals(stats[metric])}`).join("\n");
}

/** Formats a notification: a line for each metric that grew, then every total. */
export function formatReport(increases: Partial<Stats>, stats: Stats): string {
  const growth = METRICS.flatMap(([metric, label]) => {
    const increase = increases[metric];
    return increase ? [`New ${label.toLowerCase()}: ${formatTotals(increase, "+")}`] : [];
  });
  return [...growth, "", formatStats(stats)].join("\n");
}

/** Formats a release tag for display, such as `0.3.1 beta` for `v0.3.1-beta`. */
export function formatVersion(tag: string): string {
  return tag.replace(/^v/, "").replace("-", " ");
}
