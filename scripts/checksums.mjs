/** Name of the release asset listing the SHA-256 of each installer and update. */
export const CHECKSUMS = "SHA256SUMS";

/**
 * Parses `sha256sum` output into a map from file name to lowercase hex digest. Fails on any line
 * that isn't a 64-character digest followed by a file name, or on a file listed twice.
 */
export function parseChecksums(text) {
  const sums = new Map();
  for (const line of text.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const match = /^([0-9a-fA-F]{64}) [ *]?(\S+)$/.exec(line);
    if (!match) throw new Error(`${CHECKSUMS} has an invalid line: ${line}`);
    if (sums.has(match[2])) throw new Error(`${CHECKSUMS} lists ${match[2]} twice.`);
    sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}
