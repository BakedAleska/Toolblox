import { useEffect, useRef, useState } from "react";
import tokens from "../theme.css?raw";
import { bridge } from "@/bridge";
import type { AppRoute, ThemePage } from "@/types";

/** Color tokens shown in Settings, grouped. */
export const colorGroups: { title: string; tokens: [token: string, label: string][] }[] = [
  { title: "Surfaces", tokens: [["background", "Background"], ["foreground", "Text"], ["card", "Panel"], ["card-foreground", "Panel text"], ["popover", "Menu"], ["popover-foreground", "Menu text"]] },
  { title: "Controls", tokens: [["primary", "Primary"], ["primary-foreground", "Primary text"], ["secondary", "Secondary"], ["secondary-foreground", "Secondary text"], ["accent", "Hover"], ["accent-foreground", "Hover text"], ["muted", "Muted"], ["muted-foreground", "Muted text"]] },
  { title: "Lines and layers", tokens: [["border", "Border"], ["input", "Field border"], ["ring", "Focus ring"], ["overlay", "Dialog backdrop"], ["shadow", "Shadow"]] },
  { title: "Sidebar", tokens: [["sidebar", "Sidebar"], ["sidebar-foreground", "Sidebar text"], ["sidebar-primary", "Sidebar primary"], ["sidebar-primary-foreground", "Sidebar primary text"], ["sidebar-accent", "Current page"], ["sidebar-accent-foreground", "Current page text"], ["sidebar-border", "Sidebar border"], ["sidebar-ring", "Sidebar focus ring"]] },
  { title: "Status", tokens: [["success", "Success"], ["warning", "Warning"], ["destructive", "Destructive"]] },
];

/** Reads the `--name: value` declarations of one top-level block in `theme.css`. */
const tokenBlock = (selector: string): Record<string, string> => {
  const block = tokens.match(new RegExp(`^${selector} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
};

/** The default token values for each mode, read from `theme.css` so they have one source. */
export const defaultColors = { light: tokenBlock(":root"), dark: tokenBlock("\\.dark") };

/** The page a route belongs to. Widget pages count as `widgets`. */
export const pageOf = (route: AppRoute): ThemePage =>
  route === "/" ? "dashboard" : route === "/accounts" ? "accounts" : route === "/settings" ? "settings" : "widgets";

/** Selectors of the blocks the Settings controls write into the theme CSS: style tokens apply to
 * both modes, and colors to one mode each. */
const blockSelectors = { all: ":root", light: ":root:not(.dark)", dark: ":root.dark" } as const;
export type Scope = keyof typeof blockSelectors;
export type Mode = Exclude<Scope, "all">;

const blockPattern = (scope: Scope) => new RegExp(`^${blockSelectors[scope].replace(/[.()]/g, "\\$&")}\\s*\\{([^}]*)\\}\\n?`, "m");

/** The declarations in one of the theme CSS blocks, keyed by property. */
export const readBlock = (css: string, scope: Scope): Record<string, string> =>
  Object.fromEntries([...(css.match(blockPattern(scope))?.[1] ?? "").matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)].map(([, property, value]) => [property, value.trim()]));

/** Sets or removes declarations in one of the theme CSS blocks. The block is added at the end
 * when needed and removed once it's empty; the rest of the CSS is left as written, apart from
 * trailing whitespace, which is removed. */
export function setBlock(css: string, scope: Scope, changes: Record<string, string | undefined>) {
  const declarations = { ...readBlock(css, scope) };
  for (const [property, value] of Object.entries(changes)) { if (value) declarations[property] = value; else delete declarations[property]; }
  const entries = Object.entries(declarations);
  const block = entries.length ? `${blockSelectors[scope]} {\n${entries.map(([property, value]) => `  ${property}: ${value};`).join("\n")}\n}\n` : "";
  const pattern = blockPattern(scope);
  if (pattern.test(css)) return css.replace(pattern, () => block).trimEnd();
  if (!block) return css.trimEnd();
  return (css.trim() ? `${css.trimEnd()}\n\n${block}` : block).trimEnd();
}

/** A choice for a style token. The option without a value is the default and removes the token. */
export type StyleOption = { label: string; value?: string };

/** Fonts installed on both Windows and macOS, each with a fallback, so a theme never needs to
 * load one. Geist is bundled with the app. */
export const fonts: StyleOption[] = [
  { label: "Geist" },
  { label: "System", value: "system-ui, sans-serif" },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Tahoma", value: "Tahoma, Verdana, sans-serif" },
  { label: "Trebuchet MS", value: "\"Trebuchet MS\", sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: "\"Times New Roman\", Times, serif" },
  { label: "Monospace", value: "ui-monospace, Menlo, Consolas, monospace" },
];

const firstFamily = (value: string) => value.split(",")[0].replace(/["']/g, "").trim().toLowerCase();

/** The font option for a computed `--font` value, matched by its first family. */
export const currentFont = (value: string) =>
  fonts.find((font) => firstFamily(font.value ?? "Geist Variable") === firstFamily(value));

/** Body text size in points, the range Settings accepts, and the default. Body text is `text-sm`,
 * 14 px, which is 10.5 pt; every other size scales with it. */
export const textSizeRange = { min: 7, max: 21, step: 0.5, default: 10.5 };

/** The body text size in points for a computed `--text-scale` value, to the nearest half point. */
export const textSizePoints = (value: string) => Math.round((parseFloat(value) || 1) * textSizeRange.default * 2) / 2;

/** Whether a size in points can be applied. */
export const validTextSize = (points: number) => Number.isFinite(points) && points >= textSizeRange.min && points <= textSizeRange.max;

/** The `--text-scale` value for a body text size in points, or undefined for the default. */
export const textScaleValue = (points: number) => points === textSizeRange.default ? undefined : String(Number((points / textSizeRange.default).toFixed(4)));

export const densities: StyleOption[] = [{ label: "Compact", value: "0.21875rem" }, { label: "Default" }, { label: "Comfortable", value: "0.28125rem" }];

/** The density option for a computed `--spacing` value, compared as numbers since builds may
 * rewrite `0.25rem` as `.25rem`. */
export const currentDensity = (value: string) =>
  densities.find((density) => Math.abs(parseFloat(density.value ?? "0.25") - parseFloat(value)) < 1e-6);

const dataUrl = /data:([\w.+-]+\/[\w.+-]+)?[;,][^)'"\s]*/g;
const placeholder = /<embedded [^<>#]* #(\d+)>/g;

/** The file name an embedded data URL keeps in its `name` parameter. */
const embeddedName = (url: string) => {
  const name = /;name=([^;,]*)/.exec(url.slice(0, url.indexOf(",")))?.[1];
  if (!name) return undefined;
  try { return decodeURIComponent(name.replace(/\+/g, " ")).replace(/[<>#]/g, ""); } catch { return undefined; }
};

/** Theme CSS for editing, with each long data URL shown as a short numbered placeholder such as
 * `<embedded corner.png, 24 KB #1>`, or its media type when it has no file name.
 * `expandEmbedded` restores them. */
export function collapseEmbedded(css: string) {
  const urls: string[] = [];
  const text = css.replace(dataUrl, (url, mime: string | undefined) => {
    if (url.length < 256) return url;
    urls.push(url);
    return `<embedded ${embeddedName(url) || mime || "data"}, ${Math.max(1, Math.round(url.length * 0.75 / 1024))} KB #${urls.length}>`;
  });
  return { text, urls };
}

/** Restores the data URLs `collapseEmbedded` replaced. Unknown placeholders are left as typed. */
export const expandEmbedded = (text: string, urls: string[]) =>
  text.replace(placeholder, (match, index: string) => urls[Number(index) - 1] ?? match);

/** The longest side, in pixels, an embedded image is scaled down to. Large enough for a
 * full-window background on a 1080p display. */
export const MAX_IMAGE_SIDE = 1920;
const WEBP_QUALITY = 0.85;

/** Re-encodes a PNG, JPEG, or BMP data URL as WebP, scaled down to `MAX_IMAGE_SIDE`. A webview
 * that can't encode WebP only scales the image, keeping JPEG as JPEG and the rest as PNG.
 * Resolves to the original when the result isn't smaller. */
export async function shrinkImage(url: string): Promise<string> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return url;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let encoded = canvas.toDataURL("image/webp", WEBP_QUALITY);
  if (!encoded.startsWith("data:image/webp")) {
    if (scale === 1) return url;
    encoded = canvas.toDataURL(url.startsWith("data:image/jpeg") ? "image/jpeg" : "image/png", WEBP_QUALITY);
  }
  const name = /;name=[^;,]*/.exec(url.slice(0, url.indexOf(",")))?.[0] ?? "";
  const shrunk = encoded.replace(/^(data:[^;,]+)/, `$1${name}`);
  return shrunk.length < url.length ? shrunk : url;
}

/** Shrinks each PNG, JPEG, or BMP data URL in the CSS that isn't in `keep`, so images already in
 * the saved theme aren't re-encoded and lose quality again on every apply. */
export async function shrinkEmbedded(css: string, keep: string[], shrink = shrinkImage) {
  const kept = new Set(keep);
  const urls = [...new Set(css.match(dataUrl) ?? [])].filter((url) => !kept.has(url) && /^data:image\/(png|jpeg|bmp)[;,]/.test(url));
  const shrunk = new Map(await Promise.all(urls.map(async (url) => [url, await shrink(url).catch(() => url)] as const)));
  return css.replace(dataUrl, (url) => shrunk.get(url) ?? url);
}

let sheet: CSSStyleSheet | undefined;

/** Applies theme CSS through a constructed stylesheet. The CSP blocks `<style>` tags but not
 * constructed stylesheets, which also cascade after every other stylesheet. */
export function applyThemeCss(css: string) {
  if (!("adoptedStyleSheets" in document)) return;
  sheet ??= new CSSStyleSheet();
  sheet.replaceSync(css);
  if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

/** Whether the app is showing dark colors, following the `dark` class on `<html>`. */
export function useDarkMode() {
  const root = document.documentElement;
  const [dark, setDark] = useState(() => root.classList.contains("dark"));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(root.classList.contains("dark")));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [root]);
  return dark;
}

let probe: CanvasRenderingContext2D | null | undefined;

/** Converts any CSS color to `#rrggbb` for a color input. Transparency is dropped. */
export const toHex = (color: string) => {
  const hex = (channels: ArrayLike<number>) => `#${Array.from(channels).slice(0, 3).map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return hex([0, 0, 0]);
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "black";
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  return hex(probe.getImageData(0, 0, 1, 1).data);
};

/** Loads, applies, and saves the custom theme CSS. Nothing is applied while `active` is false.
 * The CSS is applied before the state changes, so a render can read the resulting token values
 * with `getComputedStyle`. */
export function useCustomTheme(ready: boolean, active: boolean, notify: (message: string) => void) {
  const [css, setCss] = useState("");
  const enabled = useRef(active);
  const pending = useRef<{ timer: number; css: string }>(undefined);
  const show = (next: string) => { applyThemeCss(enabled.current ? next : ""); setCss(next); };
  const reload = () => bridge.getTheme().then(show, (error) => notify(`The theme couldn't be loaded. Does importing it again in Settings help? (${String(error)})`));
  useEffect(() => { if (ready) void reload(); }, [ready]);
  useEffect(() => { enabled.current = active; applyThemeCss(active ? css : ""); }, [active]);

  const cancel = () => { if (pending.current) window.clearTimeout(pending.current.timer); pending.current = undefined; };
  /** Saves a delayed change now. */
  const flush = async () => {
    const next = pending.current?.css;
    cancel();
    if (next !== undefined) await bridge.saveTheme(next).catch((error) => { notify(`The theme wasn't saved. Does retrying help? (${String(error)})`); void reload(); throw error; });
  };
  /** Saves theme CSS without trailing whitespace, then applies it. With a delay it applies at once
   * and saves when changes pause, which suits colors that change continuously and can't fail
   * validation. */
  const save = async (value: string, delay = 0) => {
    const next = value.trimEnd();
    cancel();
    if (delay) { show(next); pending.current = { css: next, timer: window.setTimeout(() => void flush().catch(() => undefined), delay) }; return; }
    await bridge.saveTheme(next);
    show(next);
  };
  const exportTheme = async () => { await flush(); return bridge.exportTheme(); };
  return { css, save, exportTheme };
}

export type ThemeStore = ReturnType<typeof useCustomTheme>;
