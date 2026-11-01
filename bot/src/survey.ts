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
