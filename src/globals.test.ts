import { describe, expect, it } from "vitest";

/** Interface source, excluding tests and the sample widgets, which style themselves. */
const sources = Object.entries(import.meta.glob<string>(["./**/*.{ts,tsx}", "!./**/*.test.ts", "!./demo-widgets/**"], { query: "?raw", import: "default", eager: true }));

/** Styling that bypasses the theme tokens in `theme.css`, and so can't be changed by a theme. */
const rules: [string, RegExp][] = [
  ["a hex color", /["'`\s(]#[0-9a-fA-F]{3,8}\b/],
  ["a CSS color function", /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/],
  ["a Tailwind palette color", /\b(bg|text|border|ring|ring-offset|shadow|outline|fill|stroke|from|via|to|divide|decoration|accent|caret|placeholder)-(white|black|(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/],
  ["an arbitrary color, radius, or shadow", /\b(bg|border|ring|shadow|outline|fill|stroke|from|via|to|divide|accent|rounded(-[a-z]{1,2})?)-\[/],
  ["an arbitrary font size", /\btext-\[[\d.]+(px|rem|em)\]/],
  ["a radius outside the scale", /\brounded(-[a-z]{1,2})?-(3xl|4xl)\b/],
  ["an inline color, radius, or shadow", /style=\{\{[^}]*\b(color|background|backgroundColor|borderColor|borderRadius|boxShadow)\s*:/],
];

describe("theme globals", () => {
  it("finds the interface source", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it.each(rules)("no file uses %s", (_, pattern) => {
    const offenders = sources.flatMap(([path, source]) =>
      source.split("\n").flatMap((line, index) => pattern.test(line) ? [`${path}:${index + 1}: ${line.trim().slice(0, 120)}`] : []));
    expect(offenders).toEqual([]);
  });
});
