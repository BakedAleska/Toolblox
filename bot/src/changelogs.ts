import { discordRequest } from "./discord.ts";

/** GitHub endpoint listing the files in `changelogs/` on main. */
const CHANGELOGS_URL = "https://api.github.com/repos/BakedAleska/Toolblox/contents/changelogs?ref=main";

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
  url: string;
}

/** A changelog's parts. Released files have a date under the title instead of *Unreleased*. */
export interface Changelog {
  version: string;
  title: string;
  date: string;
  body: string;
  released: boolean;
}

/** The file each version was last seen at, and its message once posted. */
export type Posted = Record<string, { sha: string; messageId?: string }>;

/** Reads a changelog file: a `# Title` line, an italic date line, then the notes. */
export function parseChangelog(version: string, text: string): Changelog {
  const [heading = "", dateLine = "", ...rest] = text.replace(/\r\n/g, "\n").trim().split("\n");
  const title = heading.replace(/^#\s+/, "").trim() || `Toolblox ${version}`;
  const date = dateLine.trim().replace(/^\*(.*)\*$/, "$1").trim();
  return { version, title, date, body: rest.join("\n").trim(), released: date !== "" && !/unreleased/i.test(date) };
}

/** The embed for a changelog, linked to its GitHub release and cut to Discord's limit. */
export function changelogEmbed(changelog: Changelog) {
  const description = changelog.body.length > DESCRIPTION_LIMIT
    ? `${changelog.body.slice(0, DESCRIPTION_LIMIT - 1).trimEnd()}…`
    : changelog.body;
  return {
    title: changelog.title,
    url: `https://github.com/BakedAleska/Toolblox/releases/tag/v${changelog.version}`,
    description,
    footer: { text: changelog.date },
  };
}

/** Orders versions oldest first, comparing each number in them as a number. */
export const byVersion = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** Files that are new or changed since they were last seen, oldest version first. */
export function pendingChangelogs(files: ChangelogFile[], posted: Posted): ChangelogFile[] {
  return files.filter((file) => posted[file.version]?.sha !== file.sha).sort((a, b) => byVersion(a.version, b.version));
}

/** Lists `changelogs/*.md` on main. A token raises GitHub's rate limit and is optional. */
async function fetchChangelogFiles(token?: string): Promise<ChangelogFile[]> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "toolblox-bot" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(CHANGELOGS_URL, { headers });
  if (!response.ok) throw new Error(`GitHub returned status ${response.status} for the changelogs.`);
  const entries = await response.json<{ name: string; sha: string; type: string; download_url: string }[]>();
  return entries
    .filter(({ type, name }) => type === "file" && name.endsWith(".md"))
    .map(({ name, sha, download_url }) => ({ version: name.slice(0, -".md".length), sha, url: download_url }));
}

/** Finds the changelogs channel in the bot's servers, remembering its ID. */
async function changelogChannel(token: string, state: KVNamespace): Promise<string> {
  const saved = await state.get(CHANNEL_KEY);
  if (saved) return saved;
  const guilds = await (await discordRequest(token, "GET", "/users/@me/guilds")).json<{ id: string }[]>();
  for (const guild of guilds) {
    const channels = await (await discordRequest(token, "GET", `/guilds/${guild.id}/channels`)).json<{ id: string; name: string; type: number }[]>();
    const channel = channels.find(({ name, type }) => name === CHANNEL_NAME && (type === 0 || type === 5));
    if (channel) {
      await state.put(CHANNEL_KEY, channel.id);
      return channel.id;
    }
  }
  throw new Error(`The #${CHANNEL_NAME} channel wasn't found. Is the bot in the server and allowed to see it?`);
}

/**
 * Posts each released changelog that isn't in the channel yet, oldest first, and edits the embed
 * of one whose file changed. Unreleased files are skipped until their file changes. Progress is
 * saved after each message, so a failure doesn't post the same version twice.
 */
export async function syncChangelogs(token: string, state: KVNamespace, githubToken?: string): Promise<void> {
  const posted = (await state.get<Posted>(POSTED_KEY, "json")) ?? {};
  const pending = pendingChangelogs(await fetchChangelogFiles(githubToken), posted);
  if (!pending.length) return;
  let channel: string | undefined;
  for (const file of pending) {
    const response = await fetch(file.url, { headers: { "User-Agent": "toolblox-bot" } });
    if (!response.ok) throw new Error(`GitHub returned status ${response.status} for changelog ${file.version}.`);
    const changelog = parseChangelog(file.version, await response.text());
    let messageId = posted[file.version]?.messageId;
    if (changelog.released) {
      channel ??= await changelogChannel(token, state);
      const body = { embeds: [changelogEmbed(changelog)], allowed_mentions: { parse: [] } };
      const edited = messageId && (await discordRequest(token, "PATCH", `/channels/${channel}/messages/${messageId}`, body, [404])).ok;
      if (!edited) messageId = (await (await discordRequest(token, "POST", `/channels/${channel}/messages`, body)).json<{ id: string }>()).id;
    }
    posted[file.version] = { sha: file.sha, messageId };
    await state.put(POSTED_KEY, JSON.stringify(posted));
  }
}
