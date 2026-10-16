import { fetchReleases, formatVersion, latestRelease } from "./releases.ts";

/** Toolblox website. */
const SITE = "https://toolblox.dev/";

/** Slash commands, registered with `npm run register`. They work in servers and in DMs. */
export const COMMANDS = [
  { name: "link", description: "Get the Toolblox download link" },
  { name: "docs", description: "Get the widget documentation link" },
  { name: "source", description: "Get the source code link" },
  { name: "version", description: "Show the latest Toolblox version" },
].map((command) => ({ ...command, type: 1, integration_types: [0, 1], contexts: [0, 1, 2] }));

/** Returns the reply to a slash command. */
export async function respond(name: string, githubToken?: string): Promise<string> {
  switch (name) {
    case "link":
      return `Download Toolblox: ${SITE}`;
    case "docs":
      return `Widget documentation: ${SITE}docs/`;
    case "source":
      return "Source code: https://github.com/BakedAleska/Toolblox";
    case "version":
      try {
        const latest = latestRelease(await fetchReleases(githubToken));
        return latest
          ? `Latest version: ${formatVersion(latest.tag_name)}\n${latest.html_url}`
          : "No version is published yet.";
      } catch {
        return "Loading releases from GitHub failed. Try again in a minute?";
      }
    default:
      return "This command isn't supported.";
  }
}
