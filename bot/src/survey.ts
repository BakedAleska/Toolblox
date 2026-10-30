/** Beta survey answers sent by the Toolblox app. Remove with the survey after the beta. */
export interface SurveyAnswers {
  rating: number;
  comment: string;
  version: string;
}

/** Longest comment accepted, matching the app's limit. */
export const MAX_COMMENT_CHARACTERS = 2_000;
/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 16 * 1024;
/** Answers accepted from one address per window. */
export const MAX_PER_WINDOW = 3;
/** Length of the rate limit window, in seconds. KV keeps keys for at least 60 seconds. */
export const WINDOW_SECONDS = 60 * 60;

/** Returns the answers when the body is valid JSON with a 1–5 rating, or null. */
export function parseSurvey(body: string): SurveyAnswers | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { rating, comment, version } = value as Record<string, unknown>;
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  if (typeof comment !== "string" || [...comment].length > MAX_COMMENT_CHARACTERS) return null;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) return null;
  return { rating, comment: comment.trim(), version };
}

/** Builds the DM: the rating and version in the title, and the comment as the description. */
export function surveyEmbed({ rating, comment, version }: SurveyAnswers) {
  return {
    title: `Beta survey: ${rating}/5`,
    description: comment || "*No comment.*",
    footer: { text: `Toolblox ${version}` },
  };
}

/** KV key counting an address's answers. The address is hashed, so it isn't stored. */
export async function rateKey(address: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`survey:${address}`));
  return `survey:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Counts an answer from `address`, returning false when the address is over the limit. */
export async function allowSurvey(state: KVNamespace, address: string): Promise<boolean> {
  const key = await rateKey(address);
  const count = Number(await state.get(key)) || 0;
  if (count >= MAX_PER_WINDOW) return false;
  await state.put(key, String(count + 1), { expirationTtl: WINDOW_SECONDS });
  return true;
}
