import { ChevronDown, Download, ExternalLink, RotateCcw, ShieldAlert, Upload } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { bridge } from "@/bridge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { collapseEmbedded, colorGroups, currentDensity, currentFont, defaultColors, densities, expandEmbedded, fonts, readBlock, setBlock, shrinkEmbedded, textScaleValue, textSizePoints, textSizeRange, validTextSize, toHex, useDarkMode, type ThemeStore } from "@/lib/theme";
import { ChoiceRow, Group, IconButton, Panel, SettingRow, Spinner, type ScreenProps } from "@/shared";

/** Matches the theme size limit in `theme.rs`. */
const MAX_THEME_BYTES = 16 * 1024 * 1024;
/** Color changes are saved once they pause for this long, in milliseconds. */
const SAVE_DELAY = 400;

const colorProperties = colorGroups.flatMap(({ tokens }) => tokens.map(([token]) => `--${token}`));

export function ThemesTab({ state, notify, confirm, patchSettings, themes }: ScreenProps & { themes: ThemeStore }) {
  const { css, save } = themes;
  /** Unapplied edits to the CSS, or undefined while the field shows the saved CSS. */
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState<"import" | "export">();
  const importInput = useRef<HTMLInputElement>(null);

  /** Changes the saved CSS, and any unapplied edits the same way, so neither loses the change. */
  const editCss = (edit: (css: string) => string) => {
    if (draft !== undefined) setDraft(edit(draft));
    void save(edit(css), SAVE_DELAY);
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_THEME_BYTES) { notify("The file is larger than 16 MB. Can its images be smaller?"); return; }
    const contents = await file.text();
    const run = async () => {
      setBusy("import");
      try { await save(contents); setDraft(undefined); notify("Theme imported."); }
      catch (error) { notify(String(error)); }
      finally { setBusy(undefined); }
    };
    if (!css.trim()) void run();
    else confirm({ title: "Replace theme?", message: "This replaces the current custom CSS.", action: "Replace", run });
  };
  const exportFile = async () => {
    setBusy("export");
    try { notify(`Exported to ${await themes.exportTheme()}.`); }
    catch (error) { notify(`The theme wasn't exported. Is the Downloads folder writable? (${String(error)})`); }
    finally { setBusy(undefined); }
  };

  return <>
    {state.safeMode && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />The custom theme is off in safe mode.
    </p>}
    <Group title="Theme"><Panel className="divide-y">
      <ChoiceRow title="Mode" value={state.settings.themeMode} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} change={(value) => void patchSettings("themeMode", value)} />
      <SettingRow title="Share" description="Themes are shared as .css files." control={() => <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => importInput.current?.click()}>{busy === "import" ? <Spinner /> : <Upload />}Import</Button>
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void exportFile()}>{busy === "export" ? <Spinner /> : <Download />}Export</Button>
        <input ref={importInput} type="file" accept=".css,text/css" hidden onChange={(event) => void importFile(event)} />
      </div>} />
    </Panel></Group>

    <Colors css={css} editCss={editCss} />
    <Style editCss={editCss} />
    <CustomCss css={css} draft={draft} setDraft={setDraft} save={save} />
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
    <Panel className="columns-[14rem] gap-x-6 p-4">
      {colorGroups.map(({ title, tokens }) => <fieldset key={title} className="mb-4 break-inside-avoid last:mb-0">
        <legend className="mb-1 text-xs text-muted-foreground">{title}</legend>
        {tokens.map(([token, label]) => <ColorField key={token} label={label} value={values.getPropertyValue(`--${token}`).trim()} changed={`--${token}` in declared} change={(value) => set(`--${token}`, value)} />)}
      </fieldset>)}
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
    <SettingRow title="Font" control={(labelId) => <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="w-44 justify-between font-normal" aria-labelledby={labelId} />}>
        <span className="truncate">{font?.label ?? "Custom"}</span><ChevronDown className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-menu min-w-0">
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

function ColorField({ label, value, changed, change }: { label: string; value: string; changed: boolean; change: (value?: string) => void }) {
  const id = useId();
  const hex = toHex(value);
  return <div className="flex h-9 items-center gap-2">
    <input id={id} type="color" value={hex} onChange={(event) => change(event.target.value)}
      className="size-7 shrink-0 rounded-md border border-input bg-transparent p-0.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-moz-color-swatch]:rounded-sm [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0" />
    <label htmlFor={id} className="min-w-0 flex-1 truncate text-sm">{label}</label>
    <span className="font-mono text-xs text-muted-foreground">{hex}</span>
    <IconButton label={`Reset ${label}`} size="icon-sm" className={changed ? undefined : "invisible"} onClick={() => change()}><RotateCcw /></IconButton>
  </div>;
}

function CustomCss({ css, draft, setDraft, save }: { css: string; draft?: string; setDraft: (draft?: string) => void; save: ThemeStore["save"] }) {
  const id = useId();
  const shown = useMemo(() => collapseEmbedded(css), [css]);
  const text = draft ?? shown.text;
  const dirty = draft !== undefined && draft !== shown.text;
  const field = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
  }, [text]);
  const apply = async () => {
    if (draft === undefined) return;
    setBusy(true);
    try { await save(await shrinkEmbedded(await bridge.embedThemeFiles(expandEmbedded(draft.trimEnd(), shown.urls)), shown.urls)); setDraft(undefined); setError(""); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <Group title="Custom CSS" action={<div className="flex gap-2">
    <Button variant="ghost" size="sm" disabled={busy || !dirty} onClick={() => { setDraft(undefined); setError(""); }}>Revert</Button>
    <Button size="sm" disabled={busy || !dirty} onClick={() => void apply()}>{busy && <Spinner />}Apply</Button>
  </div>}><Panel className="flex flex-col gap-2 px-4 py-3">
    <p id={`${id}-d`} className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">Applied after the default styles.
      <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => void bridge.openExternal("https://toolblox.dev/docs/app/themes/")}>Documentation<ExternalLink /></Button>
    </p>
    <Textarea ref={field} rows={1} value={text} onChange={(event) => { setDraft(event.target.value); setError(""); }} spellCheck={false} placeholder=":root { --radius: 12px; }"
      className="max-h-96 min-h-8 resize-none py-1.5 font-mono text-xs" aria-label="Custom CSS" aria-describedby={error ? `${id}-e` : `${id}-d`} aria-invalid={!!error}
      onBlur={() => { if (draft !== undefined) setDraft(draft.trimEnd() === shown.text ? undefined : draft.trimEnd()); }}
      onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void apply(); } }} />
    {error && <p id={`${id}-e`} className="text-xs text-destructive" role="alert">{error}</p>}
  </Panel></Group>;
}
