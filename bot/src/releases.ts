/** A GitHub release, reduced to the fields the bot reads. */
export interface Release {
  tag_name: string;
  html_url: string;
  draft: boolean;
  assets: { name: string; download_count: number }[];
}

/** A group of release assets counted together. */
export type Kind = "windows" | "macos" | "updates";

/** Download counts per kind. */
export type Totals = Record<Kind, number>;

/** Release assets counted as downloads. Signatures and notices aren't counted. */
const KINDS: Record<string, Kind> = {
  "Toolblox-Setup.exe": "windows",
  "Toolblox.dmg": "macos",
  "Toolblox-Update.exe": "updates",
  "Toolblox.app.tar.gz": "updates",
};

/** Display names for each kind, in display order. */
const LABELS: [Kind, string][] = [
  ["windows", "Windows"],
  ["macos", "macOS"],
  ["updates", "Updates"],
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

/** Sums download counts by kind across every release. */
export function countDownloads(releases: Release[]): Totals {
  const totals: Totals = { windows: 0, macos: 0, updates: 0 };
  for (const release of releases) {
    for (const asset of release.assets) {
      const kind = KINDS[asset.name];
      if (kind) totals[kind] += asset.download_count;
    }
  }
  return totals;
}

/** Returns how much each kind grew since `previous`, or null when none grew. */
export function downloadIncrease(previous: Totals, current: Totals): Totals | null {
  const increase: Totals = { windows: 0, macos: 0, updates: 0 };
  let grew = false;
  for (const [kind] of LABELS) {
    increase[kind] = Math.max(0, current[kind] - (previous[kind] ?? 0));
    if (increase[kind] > 0) grew = true;
  }
  return grew ? increase : null;
}

/** Formats totals as one line, such as `Windows 49 · macOS 4 · Updates 12`. */
export function formatTotals(totals: Totals): string {
  return LABELS.map(([kind, label]) => `${label} ${totals[kind]}`).join(" · ");
}

/** Formats a download notification. */
export function formatIncrease(increase: Totals, current: Totals): string {
  const changes = LABELS.filter(([kind]) => increase[kind] > 0)
    .map(([kind, label]) => `${label} +${increase[kind]}`)
    .join(", ");
  return `New downloads: ${changes}\nTotal: ${formatTotals(current)}`;
}

/** Formats a release tag for display, such as `0.3.1 beta` for `v0.3.1-beta`. */
export function formatVersion(tag: string): string {
  return tag.replace(/^v/, "").replace("-", " ");
}
