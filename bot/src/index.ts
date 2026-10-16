import { respond } from "./commands.ts";
import { sendDirectMessage, verifyInteraction } from "./discord.ts";
import { countDownloads, downloadIncrease, fetchReleases, formatIncrease, formatTotals, type Totals } from "./releases.ts";

/** Worker bindings, set in `wrangler.toml` and with `wrangler secret put`. */
export interface Env {
  STATE: KVNamespace;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  OWNER_USER_ID: string;
  GITHUB_TOKEN?: string;
}

/** KV key holding the download totals from the last check. */
const TOTALS_KEY = "totals";

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
      const content = await respond(interaction.data.name, env.GITHUB_TOKEN);
      return Response.json({ type: CHANNEL_MESSAGE, data: { content, allowed_mentions: { parse: [] } } });
    }
    return new Response("Unsupported interaction.", { status: 400 });
  },

  /** Compares download totals with the last check and sends the owner a DM when they grew. */
  async scheduled(_controller, env) {
    const current = countDownloads(await fetchReleases(env.GITHUB_TOKEN));
    const previous = await env.STATE.get<Totals>(TOTALS_KEY, "json");
    if (!previous) {
      await sendDirectMessage(env.DISCORD_BOT_TOKEN, env.OWNER_USER_ID, `Download tracking started.\nTotal: ${formatTotals(current)}`);
    } else {
      const increase = downloadIncrease(previous, current);
      if (increase) await sendDirectMessage(env.DISCORD_BOT_TOKEN, env.OWNER_USER_ID, formatIncrease(increase, current));
      else if (JSON.stringify(previous) === JSON.stringify(current)) return;
    }
    await env.STATE.put(TOTALS_KEY, JSON.stringify(current));
  },
} satisfies ExportedHandler<Env>;
