/** A changelog block: a heading, a paragraph, or a bulleted list. Text keeps its `**bold**` and
 * `*italic*` markers for `inline` to split. */
export type ChangelogBlock =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "text"; text: string }
  | { kind: "list"; items: string[] };

export type Release = {
  version: string;
  /** The version as the file's title writes it, such as "0.4.8 beta". */
  title: string;
  /** The date line, such as "November 16, 2026" or "Unreleased". */
  date: string;
  /** Groups of blocks separated by `---` lines. */
  sections: ChangelogBlock[][];
};

/** Parses one `changelogs/<version>.md` file: a `#` title, an italic date line, then `##` and
 * `###` headings, bullets, paragraphs, and `---` separators. */
export function parseChangelog(version: string, markdown: string): Release {
  const release: Release = { version, title: version, date: "", sections: [[]] };
  const blocks = () => release.sections[release.sections.length - 1];
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const current = blocks();
    const last = current[current.length - 1];
    if (!line) continue;
    if (line === "---") { if (blocks().length) release.sections.push([]); continue; }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading?.[1] === "#") { release.title = heading[2].replace(/^Toolblox\s+/i, ""); continue; }
    if (heading) { blocks().push({ kind: "heading", level: heading[1].length as 2 | 3, text: heading[2] }); continue; }
    const date = line.match(/^\*([^*].*[^*]|[^*])\*$/);
    if (date && !release.date && release.sections.length === 1 && blocks().length === 0) { release.date = date[1]; continue; }
    const item = line.match(/^[-*]\s+(.*)$/);
    if (item) {
      if (last?.kind === "list") last.items.push(item[1]);
      else blocks().push({ kind: "list", items: [item[1]] });
      continue;
    }
    if (last?.kind === "text") last.text += ` ${line}`;
    else blocks().push({ kind: "text", text: line });
  }
  release.sections = release.sections.filter((section) => section.length > 0);
  return release;
}

/** Splits `**bold**` and `*italic*` runs out of text. Unmatched markers stay as text. */
export function inline(text: string): { text: string; bold?: boolean; italic?: boolean }[] {
  const parts: { text: string; bold?: boolean; italic?: boolean }[] = [];
  const pattern = /\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*/g;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > index) parts.push({ text: text.slice(index, match.index) });
    parts.push(match[1] !== undefined ? { text: match[1], bold: true } : { text: match[2], italic: true });
    index = match.index + match[0].length;
  }
  if (index < text.length) parts.push({ text: text.slice(index) });
  return parts;
}

/** Orders versions such as "0.4.10-beta" newest first. Prerelease tags sort below the release. */
export function compareVersions(a: string, b: string) {
  const split = (version: string) => {
    const [core, pre = ""] = version.split("-", 2);
    return { core: core.split(".").map(Number), pre };
  };
  const left = split(a), right = split(b);
  for (let index = 0; index < 3; index++) {
    const difference = (right.core[index] ?? 0) - (left.core[index] ?? 0);
    if (difference) return difference;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return -1;
  if (!right.pre) return 1;
  return right.pre.localeCompare(left.pre, undefined, { numeric: true });
}

const files = import.meta.glob<string>("../changelogs/*.md", { query: "?raw", import: "default", eager: true });

/** Every bundled changelog, newest first. */
export const releases: Release[] = Object.entries(files)
  .map(([path, markdown]) => parseChangelog(path.replace(/^.*\/(.+)\.md$/, "$1"), markdown))
  .sort((a, b) => compareVersions(a.version, b.version));
