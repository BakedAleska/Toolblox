import { describe, expect, it } from "vitest";
import { colorGroups, currentDensity, currentFont, defaultColors, fonts, pageOf, readBlock, setBlock, textScaleValue, textSizePoints, validTextSize } from "./lib/theme";

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
