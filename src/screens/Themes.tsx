import { ArrowLeft, ChevronDown, Download, ExternalLink, RotateCcw, ShieldAlert, Upload } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { bridge } from "@/bridge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { collapseEmbedded, colorGroups, currentDensity, currentFont, defaultColors, densities, expandEmbedded, fonts, readBlock, setBlock, shrinkEmbedded, textScaleValue, textSizePoints, textSizeRange, validTextSize, alphaOf, toHex, useDarkMode, type ThemeStore } from "@/lib/theme";
import { ChoiceRow, Group, IconButton, Panel, Screen, SettingRow, Spinner, type ScreenProps, failure } from "@/shared";

/** Matches the theme size limit in `theme.rs`. */
const MAX_THEME_BYTES = 16 * 1024 * 1024;
/** Color changes are saved once they pause for this long, in milliseconds. */
const SAVE_DELAY = 400;

const colorProperties = colorGroups.flatMap(({ tokens }) => tokens.map(([token]) => `--${token}`));

/** Theme file import and export buttons for the page header. */
export function ThemeFileTools({ notify, confirm, themes }: Pick<ScreenProps, "notify" | "confirm"> & { themes: ThemeStore }) {
  const { css, save } = themes;
  const [busy, setBusy] = useState<"import" | "export">();
  const importInput = useRef<HTMLInputElement>(null);

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_THEME_BYTES) { notify("The theme is larger than 16 MB. Can its images be smaller?"); return; }
    const contents = await file.text();
    const run = async () => {
      setBusy("import");
      try { await save(contents); notify("Theme imported."); }
      catch (error) { notify(String(error)); }
      finally { setBusy(undefined); }
    };
    if (!css.trim()) void run();
    else confirm({ title: "Replace theme?", message: "This replaces the current custom CSS.", action: "Replace", run });
  };
  const exportFile = async () => {
    setBusy("export");
    try { notify(`Theme exported to ${await themes.exportTheme()}.`); }
    catch (error) { notify(failure(`The theme couldn't be exported. Is the Downloads folder writable?`, error)); }
    finally { setBusy(undefined); }
  };

  return <>
    <IconButton label="Import theme" className="text-muted-foreground" disabled={!!busy} onClick={() => importInput.current?.click()}>{busy === "import" ? <Spinner /> : <Upload />}</IconButton>
    <IconButton label="Export theme" className="text-muted-foreground" disabled={!!busy} onClick={() => void exportFile()}>{busy === "export" ? <Spinner /> : <Download />}</IconButton>
    <input ref={importInput} type="file" accept=".css,text/css" hidden onChange={(event) => void importFile(event)} />
  </>;
}

export function ThemesTab({ state, patchSettings, themes }: ScreenProps & { themes: ThemeStore }) {
  const { css, save } = themes;
  const editCss = (edit: (css: string) => string) => void save(edit(css), SAVE_DELAY);

  return <>
    {state.safeMode && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />The custom theme is disabled in safe mode.
    </p>}
    <Group title="Theme"><Panel className="divide-y">
      <ChoiceRow title="Mode" value={state.settings.themeMode} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} change={(value) => void patchSettings("themeMode", value)} />
    </Panel></Group>

    <Colors css={css} editCss={editCss} />
    <Style editCss={editCss} />
  </>;
}

/** Shows each token's current value, including any the custom CSS sets. Picking a color writes it
 * to the custom CSS for the mode the app is showing. */
function Colors({ css, editCss }: { css: string; editCss: (edit: (css: string) => string) => void }) {
  const mode = useDarkMode() ? "dark" : "light";
  const declared = readBlock(css, mode);
  const values = getComputedStyle(document.documentElement);
  const set = (property: string, value?: string) => editCss((current) => setBlock(current, mode, { [property]: value }));
  const changed = colorProperties.some((property) => property in declared);
  return <Group title="Colors" action={changed && <Button variant="ghost" size="sm"
    onClick={() => editCss((current) => setBlock(current, mode, Object.fromEntries(colorProperties.map((property) => [property, undefined]))))}>Reset colors</Button>}>
    <Panel className="flex flex-col gap-3 p-4">
      <div className="columns-[14rem] gap-x-6">
        {colorGroups.map(({ title, tokens }) => <fieldset key={title} className="mb-4 break-inside-avoid last:mb-0">
          <legend className="mb-1 text-xs text-muted-foreground">{title}</legend>
          {tokens.map(([token, label]) => <ColorField key={token} property={`--${token}`} label={label} value={values.getPropertyValue(`--${token}`).trim()} changed={`--${token}` in declared} change={(value) => set(`--${token}`, value)} />)}
        </fieldset>)}
      </div>
    </Panel>
  </Group>;
}

/** Global style tokens. Each choice writes one token to the `:root` block of the custom CSS, and
 * the selection reads the computed value, so it re-renders with the tab whenever the CSS changes. */
function Style({ editCss }: { editCss: (edit: (css: string) => string) => void }) {
  const values = getComputedStyle(document.documentElement);
  const read = (property: string) => values.getPropertyValue(property).trim();
  const set = (property: string, value?: string) => editCss((text) => setBlock(text, "all", { [property]: value }));
  const font = currentFont(read("--font"));
  return <Group title="Style"><Panel className="divide-y">
    <SettingRow title="Font" control={() => <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="w-44 justify-between font-normal" aria-label={`Font: ${font?.label ?? "Custom"}`} />}>
        <span className="truncate">{font?.label ?? "Custom"}</span><ChevronDown className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" arrow={false} className="max-h-menu min-w-0">
        <DropdownMenuRadioGroup value={font?.label ?? ""} onValueChange={(label) => set("--font", fonts.find((option) => option.label === label)?.value)}>
          {fonts.map((option) => <DropdownMenuRadioItem key={option.label} value={option.label} style={{ fontFamily: option.value ?? defaultColors.light.font }}>{option.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>} />
    <TextSizeRow points={textSizePoints(read("--text-scale"))} change={(points) => set("--text-scale", textScaleValue(points))} />
    <ChoiceRow title="Density" value={currentDensity(read("--spacing"))?.label ?? ""} options={densities.map(({ label }) => ({ value: label, label }))}
      change={(label) => set("--spacing", densities.find((option) => option.label === label)?.value)} />
  </Panel></Group>;
}

/** Body text size in points. Values outside the range aren't applied, and leaving the field
 * restores the current size. */
function TextSizeRow({ points, change }: { points: number; change: (points: number) => void }) {
  const [draft, setDraft] = useState(String(points));
  useEffect(() => setDraft(String(points)), [points]);
  return <SettingRow title="Text size" control={(labelId) => <div className="flex items-center gap-2">
    <Input type="number" inputMode="decimal" min={textSizeRange.min} max={textSizeRange.max} step={textSizeRange.step} value={draft} aria-labelledby={labelId} className="h-7 w-20 text-right tabular-nums"
      onChange={(event) => {
        setDraft(event.target.value);
        const next = Number(event.target.value);
        if (event.target.value && validTextSize(next)) change(next);
      }}
      onBlur={() => setDraft(String(points))} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    <span className="text-sm text-muted-foreground" aria-hidden="true">pt</span>
  </div>} />;
}

/** While a color is dragged, only its token is previewed as an inline style on `<html>`. The theme
 * CSS is written once the changes pause, since rewriting it re-renders the whole app. */
function ColorField({ property, label, value, changed, change }: { property: string; label: string; value: string; changed: boolean; change: (value?: string) => void }) {
  const id = useId();
  const hex = toHex(value);
  const alpha = alphaOf(value);
  const [picked, setPicked] = useState<string>();
  const timer = useRef<number>(undefined);
  useEffect(() => setPicked(undefined), [hex]);
  const commit = (next?: string) => {
    window.clearTimeout(timer.current);
    change(next);
    document.documentElement.style.removeProperty(property);
  };
  const preview = (color: string) => {
    const next = alpha < 255 ? `${color}${alpha.toString(16).padStart(2, "0")}` : color;
    setPicked(color);
    document.documentElement.style.setProperty(property, next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(next), SAVE_DELAY);
  };
  return <div className="flex h-9 items-center gap-2">
    <input id={id} type="color" value={picked ?? hex} onChange={(event) => preview(event.target.value)}
      className="size-7 shrink-0 rounded-lg border border-input bg-transparent p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-moz-color-swatch]:rounded-sm [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0" />
    <label htmlFor={id} className="min-w-0 flex-1 truncate text-sm">{label}</label>
    <span className="font-mono text-xs text-muted-foreground">{picked ?? hex}{alpha < 255 && ` ${Math.round(alpha / 2.55)}%`}</span>
    <IconButton label={`Reset ${label}`} size="icon-sm" className={changed ? undefined : "invisible"} onClick={() => commit()}><RotateCcw /></IconButton>
  </div>;
}

/** Edits the theme's CSS as text. Embedded images show as short placeholders. */
export function CustomCssScreen({ navigate, themes }: ScreenProps & { themes: ThemeStore }) {
  const { css, save } = themes;
  const id = useId();
  const shown = useMemo(() => collapseEmbedded(css), [css]);
  /** Unapplied edits to the CSS, or undefined while the field shows the saved CSS. */
  const [draft, setDraft] = useState<string>();
  const text = draft ?? shown.text;
  const dirty = draft !== undefined && draft !== shown.text;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    if (draft === undefined) return;
    setBusy(true);
    try { await save(await shrinkEmbedded(await bridge.embedThemeFiles(expandEmbedded(draft.trimEnd(), shown.urls)), shown.urls)); setDraft(undefined); setError(""); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <Screen title="Custom CSS" actions={<IconButton label="Back to settings" onClick={() => navigate("/settings")}><ArrowLeft /></IconButton>} toolbar={<>
    <Button variant="link" size="sm" className="mr-auto h-auto px-0 text-xs" onClick={() => void bridge.openExternal("https://toolblox.dev/docs/app/themes/")}>Documentation<ExternalLink /></Button>
    <Button variant="ghost" size="sm" disabled={busy || !dirty} onClick={() => { setDraft(undefined); setError(""); }}>Revert</Button>
    <Button size="sm" disabled={busy || !dirty} onClick={() => void apply()}>{busy && <Spinner />}Apply</Button>
  </>}>
    <Textarea autoFocus value={text} onChange={(event) => { setDraft(event.target.value); setError(""); }} spellCheck={false} placeholder=":root { --radius: 12px; }"
      className="min-h-40 flex-1 resize-none font-mono text-xs" aria-label="Custom CSS" aria-describedby={error ? `${id}-e` : undefined} aria-invalid={!!error}
      onBlur={() => { if (draft !== undefined) setDraft(draft.trimEnd() === shown.text ? undefined : draft.trimEnd()); }}
      onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void apply(); } }} />
    {error && <p id={`${id}-e`} className="text-xs text-destructive" role="alert">{error}</p>}
  </Screen>;
}
