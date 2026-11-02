/** A GitHub release, reduced to the fields the bot reads. */
export interface Release {
  tag_name: string;
  html_url: string;
  draft: boolean;
}

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

/** Formats a release tag for display, such as `0.3.1 beta` for `v0.3.1-beta`. */
export function formatVersion(tag: string): string {
  return tag.replace(/^v/, "").replace("-", " ");
}
