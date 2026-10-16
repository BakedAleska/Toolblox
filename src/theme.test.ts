import { describe, expect, it } from "vitest";
import { collapseEmbedded, colorGroups, currentDensity, currentFont, defaultColors, expandEmbedded, fonts, shrinkEmbedded, pageOf, readBlock, setBlock, textScaleValue, textSizePoints, validTextSize } from "./lib/theme";

const editable = colorGroups.flatMap(({ tokens }) => tokens.map(([token]) => token)).sort();

describe("theme tokens", () => {
  it("lets every color token in theme.css be edited, in both modes", () => {
    const colors = (mode: "light" | "dark") => Object.keys(defaultColors[mode]).filter((token) => !["radius", "font", "text-scale"].includes(token)).sort();
    expect(colors("light")).toEqual(editable);
    expect(colors("dark")).toEqual(editable);
  });

  it("derives every radius from --radius", () => {
    expect(defaultColors.light.radius).toBe("8px");
  });
});

describe("style controls", () => {
  it("matches fonts by their first family, however they're quoted", () => {
    expect(currentFont('"Geist Variable", sans-serif')?.label).toBe("Geist");
    expect(currentFont("system-ui, sans-serif")?.label).toBe("System");
    expect(currentFont("'Trebuchet MS', sans-serif")?.label).toBe("Trebuchet MS");
    expect(currentFont("Comic Sans MS, cursive")).toBeUndefined();
    expect(new Set(fonts.map(({ label }) => label)).size).toBe(fonts.length);
  });

  it("reads and writes body text size in points", () => {
    expect(textSizePoints("1")).toBe(10.5);
    expect(textSizePoints("")).toBe(10.5);
    expect(textScaleValue(10.5)).toBeUndefined();
    for (const points of [7, 9.5, 12, 14, 21]) expect(textSizePoints(textScaleValue(points)!)).toBe(points);
    expect(validTextSize(12)).toBe(true);
    expect(validTextSize(6)).toBe(false);
    expect(validTextSize(30)).toBe(false);
  });

  it("reads density as a number, however the build writes it", () => {
    expect(currentDensity(".25rem")?.label).toBe("Default");
    expect(currentDensity("0.21875rem")?.label).toBe("Compact");
    expect(currentDensity("0.3rem")).toBeUndefined();
  });

  it("only sets tokens theme.css defines or Tailwind provides", () => {
    expect(defaultColors.light.font).toContain("Geist");
    expect(defaultColors.light["text-scale"]).toBe("1");
  });
});

describe("theme pages", () => {
  it("maps routes to pages", () => {
    expect(pageOf("/")).toBe("dashboard");
    expect(pageOf("/accounts")).toBe("accounts");
    expect(pageOf("/settings")).toBe("settings");
    expect(pageOf("/widgets")).toBe("widgets");
    expect(pageOf("/widgets/trade-tracker/settings")).toBe("widgets");
  });
});

describe("color blocks", () => {
  it("adds a block for the mode at the end of the CSS", () => {
    expect(setBlock("", "dark", { "--primary": "#112233" })).toBe(":root.dark {\n  --primary: #112233;\n}");
    expect(setBlock("main { opacity: 1 }", "light", { "--primary": "#112233" }))
      .toBe("main { opacity: 1 }\n\n:root:not(.dark) {\n  --primary: #112233;\n}");
  });

  it("changes a declaration in place and keeps the rest of the CSS", () => {
    const css = "/* mine */\n:root.dark {\n  --primary: #112233;\n  --radius: 4px;\n}\nmain { opacity: 1 }\n";
    const next = setBlock(css, "dark", { "--primary": "#445566" });
    expect(next).toBe("/* mine */\n:root.dark {\n  --primary: #445566;\n  --radius: 4px;\n}\nmain { opacity: 1 }");
    expect(readBlock(next, "dark")).toEqual({ "--primary": "#445566", "--radius": "4px" });
    expect(readBlock(next, "light")).toEqual({});
  });

  it("removes the block once it's empty", () => {
    const css = setBlock("main { opacity: 1 }\n", "light", { "--card": "#ffffff" });
    expect(setBlock(css, "light", { "--card": undefined })).toBe("main { opacity: 1 }");
  });

  it("keeps style tokens in a :root block of their own", () => {
    const css = setBlock(setBlock("", "dark", { "--card": "#000000" }), "all", { "--spacing": "0.21875rem" });
    expect(css).toBe(":root.dark {\n  --card: #000000;\n}\n\n:root {\n  --spacing: 0.21875rem;\n}");
    expect(readBlock(css, "all")).toEqual({ "--spacing": "0.21875rem" });
    expect(readBlock(css, "dark")).toEqual({ "--card": "#000000" });
  });

  it("never ends with blank lines", () => {
    expect(setBlock("main { opacity: 1 }\n\n\n", "all", {})).toBe("main { opacity: 1 }");
    expect(setBlock(":root {\n  --radius: 4px;\n}\n\n", "all", { "--radius": "6px" })).toBe(":root {\n  --radius: 6px;\n}");
  });

  it("keeps each mode's block separate", () => {
    const css = setBlock(setBlock("", "light", { "--card": "#ffffff" }), "dark", { "--card": "#000000" });
    expect(readBlock(css, "light")).toEqual({ "--card": "#ffffff" });
    expect(readBlock(css, "dark")).toEqual({ "--card": "#000000" });
  });
});

describe("embedded files", () => {
  const image = `data:image/png;base64,${"A".repeat(4096)}`;
  const pixel = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

  it("shows long data URLs as placeholders and restores them", () => {
    const css = `main { background: url("${image}") } a { background: url(${pixel}) } b { background: url(${image}) }`;
    const { text, urls } = collapseEmbedded(css);
    expect(text).toBe(`main { background: url("<embedded image/png, 3 KB #1>") } a { background: url(${pixel}) } b { background: url(<embedded image/png, 3 KB #2>) }`);
    expect(expandEmbedded(text, urls)).toBe(css);
  });

  it("names placeholders after the embedded file", () => {
    const named = `data:image/png;name=my+corner%231.png;base64,${"A".repeat(4096)}`;
    const { text, urls } = collapseEmbedded(`a { background: url(${named}) }`);
    expect(text).toBe("a { background: url(<embedded my corner1.png, 3 KB #1>) }");
    expect(expandEmbedded(text, urls)).toBe(`a { background: url(${named}) }`);
  });

  it("leaves unknown placeholders as typed", () => {
    expect(expandEmbedded("url(<embedded image/png, 3 KB #9>)", [image])).toBe("url(<embedded image/png, 3 KB #9>)");
  });

  it("shrinks only new PNG, JPEG, and BMP images", async () => {
    const saved = "data:image/png;base64,SAVED";
    const css = `a { background: url(${saved}) } b { background: url("data:image/jpeg;name=a.jpg;base64,NEW") } c { background: url(data:image/svg+xml;base64,SVG) } d { background: url(data:image/jpeg;name=a.jpg;base64,NEW) }`;
    const shrink = async (url: string) => url.replace(/^data:image\/\w+/, "data:image/webp").replace("NEW", "SMALL");
    expect(await shrinkEmbedded(css, [saved], shrink)).toBe(`a { background: url(${saved}) } b { background: url("data:image/webp;name=a.jpg;base64,SMALL") } c { background: url(data:image/svg+xml;base64,SVG) } d { background: url(data:image/webp;name=a.jpg;base64,SMALL) }`);
  });
});
