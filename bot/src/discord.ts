/** Discord REST API base URL. */
const API = "https://discord.com/api/v10";

/** Converts a hex string to bytes, or returns null when it isn't valid hex. */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Returns whether a request carries a valid Ed25519 signature from Discord. Discord signs the
 * timestamp followed by the raw body with the application's public key.
 */
export async function verifyInteraction(
  body: string,
  signature: string | null,
  timestamp: string | null,
  publicKey: string,
): Promise<boolean> {
  if (!signature || !timestamp) return false;
  const signatureBytes = hexToBytes(signature);
  const keyBytes = hexToBytes(publicKey);
  if (signatureBytes?.length !== 64 || keyBytes?.length !== 32) return false;
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, signatureBytes, new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

/**
 * Sends a request to the Discord API as the bot. Fails with the status unless the response is OK
 * or its status is in `allowed`, which the caller handles.
 */
export async function discordRequest(token: string, method: string, path: string, body?: unknown, allowed: number[] = []): Promise<Response> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok && !allowed.includes(response.status)) throw new Error(`Discord returned status ${response.status} for ${method} ${path.replace(/\d{6,}/g, ":id")}.`);
  return response;
}

/** Finds a text or announcement channel by name in the bot's servers, remembering its ID in KV under `key`. */
export async function findChannel(token: string, state: KVNamespace, name: string, key: string): Promise<string> {
  const saved = await state.get(key);
  if (saved) return saved;
  const guilds = await (await discordRequest(token, "GET", "/users/@me/guilds")).json<{ id: string }[]>();
  for (const guild of guilds) {
    const channels = await (await discordRequest(token, "GET", `/guilds/${guild.id}/channels`)).json<{ id: string; name: string; type: number }[]>();
    const channel = channels.find((channel) => channel.name === name && (channel.type === 0 || channel.type === 5));
    if (channel) {
      await state.put(key, channel.id);
      return channel.id;
    }
  }
  throw new Error(`The #${name} channel wasn't found. Is the bot in the server and allowed to see it?`);
}

/**
 * Makes a channel's messages match `bodies`: edits those in `messageIds`, posts any that are
 * missing, and deletes extras. `messageIds` is updated in place and `save` runs after each
 * message, so a failure doesn't post the same message twice.
 */
export async function syncMessages(token: string, channel: string, bodies: object[], messageIds: string[], save: () => Promise<void>): Promise<void> {
  for (const [index, message] of bodies.entries()) {
    const body = { ...message, allowed_mentions: { parse: [] } };
    const id = messageIds[index];
    const edited = id && (await discordRequest(token, "PATCH", `/channels/${channel}/messages/${id}`, body, [404])).ok;
    if (!edited) messageIds[index] = (await (await discordRequest(token, "POST", `/channels/${channel}/messages`, body)).json<{ id: string }>()).id;
    await save();
  }
  for (const id of messageIds.splice(bodies.length)) await discordRequest(token, "DELETE", `/channels/${channel}/messages/${id}`, undefined, [404]);
}
