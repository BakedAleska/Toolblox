import { respond } from "./commands.ts";
import { syncChangelogs } from "./changelogs.ts";
import { verifyInteraction } from "./discord.ts";

/** Worker bindings, set in `wrangler.toml` and with `wrangler secret put`. */
export interface Env {
  STATE: KVNamespace;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  GITHUB_TOKEN?: string;
}

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
   * Posts new released changelogs to the #changelogs channel. Secrets are trimmed, because a
   * secret piped from `echo` ends with a newline.
   */
  async scheduled(_controller, env) {
    await syncChangelogs(env.DISCORD_BOT_TOKEN.trim(), env.STATE, env.GITHUB_TOKEN?.trim());
  },
} satisfies ExportedHandler<Env>;
