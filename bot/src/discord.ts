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

/** Sends a direct message from the bot. The bot and the user must share a server. */
export async function sendDirectMessage(token: string, userId: string, content: string): Promise<void> {
  const channel = await discordRequest(token, "POST", "/users/@me/channels", { recipient_id: userId });
  const { id } = await channel.json<{ id: string }>();
  await discordRequest(token, "POST", `/channels/${id}/messages`, { content, allowed_mentions: { parse: [] } });
}
