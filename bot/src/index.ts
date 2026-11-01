import { respond } from "./commands.ts";
import { syncChangelogs } from "./changelogs.ts";
import { sendDirectMessage, verifyInteraction } from "./discord.ts";
import { allowRequest } from "./limit.ts";
import { MAX_BODY_BYTES, parseSurvey, surveyEmbed } from "./survey.ts";
import {
  compareStats,
  countDownloads,
  countUpdates,
  emptyTotals,
  fetchReleases,
  formatReport,
  formatStats,
  type Stats,
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
 * KV key holding the totals from the last check. Changing it restarts tracking with a
 * "Download tracking started" message, as when the counted assets changed.
 */
const STATS_KEY = "stats";

/** KV key holding first downloads from the website per platform. */
const USERS_KEY = "users";

/** The website, the only page whose first downloads are counted. */
const SITE_ORIGIN = "https://toolblox.dev";

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
  if (!(await allowRequest(env.STATE, "survey", request.headers.get("CF-Connecting-IP") ?? "unknown"))) {
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

/**
 * Counts a first download from the website, sent by toolblox.dev the first time a browser
 * downloads Toolblox. Only the platform is counted. Requests from other pages or over the
 * per-address limit are rejected.
 */
async function receiveDownload(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Not found.", { status: 404 });
  if (request.headers.get("Origin") !== SITE_ORIGIN) return new Response("Forbidden.", { status: 403 });
  const kind = new URL(request.url).searchParams.get("platform");
  if (kind !== "windows" && kind !== "macos") return new Response("Invalid platform.", { status: 400 });
  if (!(await allowRequest(env.STATE, "download", request.headers.get("CF-Connecting-IP") ?? "unknown"))) {
    return new Response("Too many downloads.", { status: 429 });
  }
  const users = (await env.STATE.get<Totals>(USERS_KEY, "json")) ?? emptyTotals();
  users[kind] += 1;
  await env.STATE.put(USERS_KEY, JSON.stringify(users));
  return new Response(null, { status: 204 });
}

export default {
  /**
   * Receives beta survey answers at `/survey` and first downloads at `/download`, and answers
   * Discord interactions everywhere else.
   * Interactions without a valid Discord signature are rejected.
   */
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/survey") return receiveSurvey(request, env);
    if (pathname === "/download") return receiveDownload(request, env);
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
   * Posts new released changelogs to the #changelogs channel, then compares downloads, users, and
   * updates with the last check and sends the owner a DM when any grew. A changelog failure is
   * logged and doesn't stop the check. Secrets are trimmed, because a secret piped from `echo`
   * ends with a newline.
   */
  async scheduled(_controller, env) {
    const token = env.DISCORD_BOT_TOKEN.trim();
    const owner = env.OWNER_USER_ID.trim();
    await syncChangelogs(token, env.STATE, env.GITHUB_TOKEN?.trim()).catch((error) => console.warn(`Changelogs weren't posted: ${error}`));
    const releases = await fetchReleases(env.GITHUB_TOKEN?.trim());
    const current: Stats = {
      downloads: countDownloads(releases),
      users: (await env.STATE.get<Totals>(USERS_KEY, "json")) ?? emptyTotals(),
      updates: countUpdates(releases),
    };
    const previous = await env.STATE.get<Stats>(STATS_KEY, "json");
    if (!previous) {
      await sendDirectMessage(token, owner, `Download tracking started.\n${formatStats(current)}`);
      await env.STATE.put(STATS_KEY, JSON.stringify(current));
      return;
    }
    const { increases, totals } = compareStats(previous, current);
    if (formatStats(totals) !== formatStats(current)) {
      console.warn(`Counts were lower than saved:\n${formatStats(current)}\nSaved:\n${formatStats(totals)}`);
    }
    if (!Object.keys(increases).length) return;
    await sendDirectMessage(token, owner, formatReport(increases, totals));
    await env.STATE.put(STATS_KEY, JSON.stringify(totals));
  },
} satisfies ExportedHandler<Env>;
