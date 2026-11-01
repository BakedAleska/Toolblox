import { describe, expect, it } from "vitest";
import { parseChecksums } from "./checksums.mjs";

const digest = "ab".repeat(32);

describe("parseChecksums", () => {
  it("reads sha256sum output in text and binary mode", () => {
    const sums = parseChecksums(`${digest}  Toolblox-Update.exe\n${"CD".repeat(32)} *Toolblox.app.tar.gz\n\n`);
    expect([...sums]).toEqual([["Toolblox-Update.exe", digest], ["Toolblox.app.tar.gz", "cd".repeat(32)]]);
  });

  it("rejects malformed lines and duplicate files", () => {
    expect(() => parseChecksums(`${digest.slice(2)}  Toolblox-Update.exe`)).toThrow(/invalid line/);
    expect(() => parseChecksums(`${digest}`)).toThrow(/invalid line/);
    expect(() => parseChecksums(`${digest}  a b`)).toThrow(/invalid line/);
    expect(() => parseChecksums(`${digest}  Toolblox-Update.exe\n${digest}  Toolblox-Update.exe`)).toThrow(/twice/);
  });
});
