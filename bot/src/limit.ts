/** Requests accepted from one address per window, for each scope. */
export const MAX_PER_WINDOW = 3;
/** Length of the rate limit window, in seconds. KV keeps keys for at least 60 seconds. */
export const WINDOW_SECONDS = 60 * 60;

/** KV key counting an address's requests in `scope`. The address is hashed, so it isn't stored. */
export async function rateKey(scope: string, address: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}:${address}`));
  return `${scope}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Counts a request from `address` in `scope`, returning false when the address is over the limit. */
export async function allowRequest(state: KVNamespace, scope: string, address: string): Promise<boolean> {
  const key = await rateKey(scope, address);
  const count = Number(await state.get(key)) || 0;
  if (count >= MAX_PER_WINDOW) return false;
  await state.put(key, String(count + 1), { expirationTtl: WINDOW_SECONDS });
  return true;
}
