import { respond } from "./commands.ts";
import { sendDirectMessage, verifyInteraction } from "./discord.ts";
import {
  countDownloads,
  downloadIncrease,
  fetchReleases,
  formatIncrease,
  formatTotals,
  highestTotals,
  type Totals,
} from "./releases.ts";

/** Worker bindings, set in `wrangler.toml` and with `wrangler secret put`. */
export interface Env {
  STATE: KVNamespace;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  OWNER_USER_ID: string;
  GITHUB_TOKEN?: string;
}

/**
 * KV key holding the download totals from the last check. Changing it restarts tracking with a
 * "Download tracking started" message, as when the counted assets changed.
 */
const TOTALS_KEY = "downloads";

/** Discord interaction and response types. */
const PING = 1;
const APPLICATION_COMMAND = 2;
const PONG = 1;
const CHANNEL_MESSAGE = 4;

export default {
  /** Answers Discord interactions. Requests without a valid Discord signature are rejected. */
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Not found.", { status: 404 });
    const body = await request.text();
    const valid = await verifyInteraction(
      body,
      request.headers.get("X-Signature-Ed25519"),
      request.headers.get("X-Signature-Timestamp"),
      env.DISCORD_PUBLIC_KEY,
    );
    if (!valid) return new Response("Invalid signature.", { status: 401 });

    const interaction = JSON.parse(body) as { type: number; data?: { name: string } };
    if (interaction.type === PING) return Response.json({ type: PONG });
    if (interaction.type === APPLICATION_COMMAND && interaction.data) {
      const content = await respond(interaction.data.name, env.GITHUB_TOKEN?.trim());
      return Response.json({ type: CHANNEL_MESSAGE, data: { content, allowed_mentions: { parse: [] } } });
    }
    return new Response("Unsupported interaction.", { status: 400 });
  },

  /**
   * Compares download totals with the last check and sends the owner a DM when they grew. Secrets
   * are trimmed, because a secret piped from `echo` ends with a newline.
   */
  async scheduled(_controller, env) {
    const token = env.DISCORD_BOT_TOKEN.trim();
    const owner = env.OWNER_USER_ID.trim();
    const current = countDownloads(await fetchReleases(env.GITHUB_TOKEN?.trim()));
    const previous = await env.STATE.get<Totals>(TOTALS_KEY, "json");
    if (!previous) {
      await sendDirectMessage(token, owner, `Download tracking started.\nTotal: ${formatTotals(current)}`);
      await env.STATE.put(TOTALS_KEY, JSON.stringify(current));
      return;
    }
    const totals = highestTotals(previous, current);
    if (formatTotals(totals) !== formatTotals(current)) {
      console.warn(`GitHub reported fewer downloads: ${formatTotals(current)}, saved ${formatTotals(previous)}.`);
    }
    const increase = downloadIncrease(previous, current);
    if (!increase) return;
    await sendDirectMessage(token, owner, formatIncrease(increase, totals));
    await env.STATE.put(TOTALS_KEY, JSON.stringify(totals));
  },
} satisfies ExportedHandler<Env>;
