import { findChannel, syncMessages } from "./discord.ts";

/** GitHub endpoint listing the files in `changelogs/` on main. */
const CHANGELOGS_URL = "https://api.github.com/repos/BakedAleska/Toolblox/contents/changelogs?ref=main";

/** GitHub endpoint serving a file's exact content by SHA. Raw URLs on main are cached and can lag behind the listing. */
const BLOBS_URL = "https://api.github.com/repos/BakedAleska/Toolblox/git/blobs";

/** Name of the Discord channel the bot posts changelogs in. */
const CHANNEL_NAME = "changelogs";

/** KV keys: what was posted for each version, and the channel's ID once found. */
const POSTED_KEY = "changelogs";
const CHANNEL_KEY = "changelog-channel";

/** Discord's limit on an embed description. */
const DESCRIPTION_LIMIT = 4096;

/** A changelog file on GitHub. The SHA changes whenever the file does. */
export interface ChangelogFile {
  version: string;
  sha: string;
}

/** A changelog's parts. Released files have a date under the title instead of *Unreleased*. */
export interface Changelog {
  version: string;
  title: string;
  date: string;
  body: string;
  released: boolean;
}

/** The file each version was last seen at, and its messages once posted. `messageId` is the older single-message form. */
export type Posted = Record<string, { sha: string; messageIds?: string[]; messageId?: string }>;

/** Reads a changelog file: a `# Title` line, an italic date line, then the notes. */
export function parseChangelog(version: string, text: string): Changelog {
  const [heading = "", dateLine = "", ...rest] = text.replace(/\r\n/g, "\n").trim().split("\n");
  const title = heading.replace(/^#\s+/, "").trim() || `Toolblox ${version}`;
  const date = dateLine.trim().replace(/^\*(.*)\*$/, "$1").trim();
  return { version, title, date, body: rest.join("\n").trim(), released: date !== "" && !/unreleased/i.test(date) };
}

/** The embeds for a changelog, one per message. A `---` line starts a new message. The first links
 * to the GitHub release, the last carries the date, and each is cut to Discord's limit. */
export function changelogEmbeds(changelog: Changelog) {
  const parts = changelog.body.split(/^---$/m).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) parts.push("");
  return parts.map((part, index) => ({
    ...(index === 0 && { title: changelog.title, url: `https://github.com/BakedAleska/Toolblox/releases/tag/v${changelog.version}` }),
    description: part.length > DESCRIPTION_LIMIT ? `${part.slice(0, DESCRIPTION_LIMIT - 1).trimEnd()}…` : part,
    ...(index === parts.length - 1 && { footer: { text: changelog.date } }),
  }));
}

/** Orders versions oldest first, comparing each number in them as a number. */
export const byVersion = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** Files that are new or changed since they were last seen, oldest version first. */
export function pendingChangelogs(files: ChangelogFile[], posted: Posted): ChangelogFile[] {
  return files.filter((file) => posted[file.version]?.sha !== file.sha).sort((a, b) => byVersion(a.version, b.version));
}

/** GitHub request headers. A token raises GitHub's rate limit and is optional. */
const githubHeaders = (accept: string, token?: string): Record<string, string> => ({
  Accept: accept,
  "User-Agent": "toolblox-bot",
  ...(token && { Authorization: `Bearer ${token}` }),
});

/** Lists `changelogs/*.md` on main. */
async function fetchChangelogFiles(token?: string): Promise<ChangelogFile[]> {
  const response = await fetch(CHANGELOGS_URL, { headers: githubHeaders("application/vnd.github+json", token) });
  if (!response.ok) throw new Error(`GitHub returned status ${response.status} for the changelogs.`);
  const entries = await response.json<{ name: string; sha: string; type: string }[]>();
  return entries
    .filter(({ type, name }) => type === "file" && name.endsWith(".md"))
    .map(({ name, sha }) => ({ version: name.slice(0, -".md".length), sha }));
}

/**
 * Posts each released changelog that isn't in the channel yet, oldest first, and edits the
 * messages of one whose file changed, adding or deleting messages when its part count changed.
 * Unreleased files are skipped until their file changes. Progress is saved after each message,
 * so a failure doesn't post the same part twice.
 */
export async function syncChangelogs(token: string, state: KVNamespace, githubToken?: string): Promise<void> {
  const posted = (await state.get<Posted>(POSTED_KEY, "json")) ?? {};
  const pending = pendingChangelogs(await fetchChangelogFiles(githubToken), posted);
  if (!pending.length) return;
  let channel: string | undefined;
  for (const file of pending) {
    const response = await fetch(`${BLOBS_URL}/${file.sha}`, { headers: githubHeaders("application/vnd.github.raw+json", githubToken) });
    if (!response.ok) throw new Error(`GitHub returned status ${response.status} for changelog ${file.version}.`);
    const changelog = parseChangelog(file.version, await response.text());
    const previous = posted[file.version];
    const messageIds = previous?.messageIds ?? (previous?.messageId ? [previous.messageId] : []);
    if (changelog.released) {
      channel ??= await findChannel(token, state, CHANNEL_NAME, CHANNEL_KEY);
      posted[file.version] = { sha: previous?.sha ?? "", messageIds };
      await syncMessages(token, channel, changelogEmbeds(changelog).map((embed) => ({ embeds: [embed] })), messageIds, () => state.put(POSTED_KEY, JSON.stringify(posted)));
    }
    posted[file.version] = messageIds.length ? { sha: file.sha, messageIds } : { sha: file.sha };
    await state.put(POSTED_KEY, JSON.stringify(posted));
  }
}
