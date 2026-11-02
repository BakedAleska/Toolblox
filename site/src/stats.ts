/** A GitHub release, reduced to the fields the website reads. */
export interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  draft: boolean;
  assets: { name: string; download_count: number }[];
}

/** Counts for each platform. */
export interface Totals {
  windows: number;
  macos: number;
}

/** GitHub endpoint listing every release, newest first. */
export const RELEASES_URL = "https://api.github.com/repos/BakedAleska/Toolblox/releases?per_page=100";

/** Sums both platforms. */
export const sum = ({ windows, macos }: Totals) => windows + macos;

/**
 * Sums installer downloads per platform. Re-downloads count again. Windows installers count only
 * from releases with a separate `Toolblox-Update.exe`, because before 0.3.0 the updater also
 * downloaded the installer.
 */
export function countDownloads(releases: Release[]): Totals {
  const totals = { windows: 0, macos: 0 };
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
 * Sums app updates per platform: downloads of `Toolblox-Update.exe` and `Toolblox.app.tar.gz`.
 * Releases without `SHA256SUMS` were also downloaded once per manifest build, so those builds,
 * counted by downloads of the matching `.sig`, are subtracted.
 */
export function countUpdates(releases: Release[]): Totals {
  const totals = { windows: 0, macos: 0 };
  for (const release of releases) {
    const count = (name: string) => release.assets.find((asset) => asset.name === name)?.download_count ?? 0;
    const builds = (signature: string) => (release.assets.some((asset) => asset.name === "SHA256SUMS") ? 0 : count(signature));
    totals.windows += Math.max(0, count("Toolblox-Update.exe") - builds("Toolblox-Setup.exe.sig"));
    totals.macos += Math.max(0, count("Toolblox.app.tar.gz") - builds("Toolblox.app.tar.gz.sig"));
  }
  return totals;
}

/** Formats a release tag for display, such as `0.3.1 beta` for `v0.3.1-beta`. */
export const formatVersion = (tag: string) => tag.replace(/^v/, "").replace("-", " ");

/** Formats a count with thousands separators. */
export const formatCount = (count: number) => count.toLocaleString("en-US");
