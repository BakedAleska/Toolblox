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

/** Sends a direct message from the bot. The bot and the user must share a server. */
export async function sendDirectMessage(token: string, userId: string, content: string): Promise<void> {
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  const channel = await fetch(`${API}/users/@me/channels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!channel.ok) throw new Error(`Discord returned status ${channel.status} opening the direct message.`);
  const { id } = await channel.json<{ id: string }>();
  const message = await fetch(`${API}/channels/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!message.ok) throw new Error(`Discord returned status ${message.status} sending the direct message.`);
}
