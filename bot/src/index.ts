import { respond } from "./commands.ts";
import { syncChangelogs } from "./changelogs.ts";
import { sendDirectMessage, verifyInteraction } from "./discord.ts";
import { MAX_BODY_BYTES, allowSurvey, parseSurvey, surveyEmbed } from "./survey.ts";
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

/**
 * Sends beta survey answers from the app to the owner as a DM. Anyone can call this, so answers
 * are validated and limited per address.
 */
async function receiveSurvey(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Not found.", { status: 404 });
  if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) return new Response("Too large.", { status: 413 });
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return new Response("Too large.", { status: 413 });
  const answers = parseSurvey(body);
  if (!answers) return new Response("Invalid answers.", { status: 400 });
  if (!(await allowSurvey(env.STATE, request.headers.get("CF-Connecting-IP") ?? "unknown"))) {
    return new Response("Too many answers.", { status: 429 });
  }
  try {
    await sendDirectMessage(env.DISCORD_BOT_TOKEN.trim(), env.OWNER_USER_ID.trim(), "", [surveyEmbed(answers)]);
  } catch (error) {
    console.warn(`Survey answers weren't sent: ${error}`);
    return new Response("Not delivered.", { status: 502 });
  }
  return new Response(null, { status: 204 });
}

export default {
  /**
   * Receives beta survey answers at `/survey`, and answers Discord interactions everywhere else.
   * Interactions without a valid Discord signature are rejected.
   */
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/survey") return receiveSurvey(request, env);
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
   * Posts new released changelogs to the #changelogs channel, then compares download totals with
   * the last check and sends the owner a DM when they grew. A changelog failure is logged and
   * doesn't stop the download check. Secrets are trimmed, because a secret piped from `echo` ends
   * with a newline.
   */
  async scheduled(_controller, env) {
    const token = env.DISCORD_BOT_TOKEN.trim();
    const owner = env.OWNER_USER_ID.trim();
    await syncChangelogs(token, env.STATE, env.GITHUB_TOKEN?.trim()).catch((error) => console.warn(`Changelogs weren't posted: ${error}`));
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
