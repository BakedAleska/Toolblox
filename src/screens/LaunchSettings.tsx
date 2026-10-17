import { ExternalLink } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { bridge } from "@/bridge";
import { accountName } from "@/logic";
import { Spinner } from "@/shared";
import type { Account, AppState, ClientSettings, FastFlags } from "@/types";

/** Client settings as the text in their fields. Empty means unset. */
export type ClientSettingsDraft = { fpsCap: string; graphicsQuality: string; width: string; height: string };

export const draftFrom = (settings: ClientSettings): ClientSettingsDraft => ({
  fpsCap: settings.fpsCap?.toString() ?? "",
  graphicsQuality: settings.graphicsQuality?.toString() ?? "",
  width: settings.windowSize?.width.toString() ?? "",
  height: settings.windowSize?.height.toString() ?? "",
});

const whole = (text: string) => text.trim() === "" ? null : Number.isInteger(Number(text)) ? Number(text) : NaN;

/** Reads the fields, or returns a message when one isn't a whole number or the size is half set. Rust checks the ranges. */
export function settingsFrom(draft: ClientSettingsDraft): ClientSettings | string {
  const [fpsCap, graphicsQuality, width, height] = [draft.fpsCap, draft.graphicsQuality, draft.width, draft.height].map(whole);
  if ([fpsCap, graphicsQuality, width, height].some(Number.isNaN)) return "Each value must be a whole number. Can you check them?";
  if ((width === null) !== (height === null)) return "The window size needs a width and a height. Can you fill in both?";
  return { fpsCap, graphicsQuality, windowSize: width !== null && height !== null ? { width, height } : null };
}

/** Reads FastFlags JSON, or returns a message when it isn't one object. Empty text is no flags. */
export function flagsFrom(text: string): FastFlags | string {
  let flags: unknown;
  try { flags = JSON.parse(text.trim() || "{}"); }
  catch { return "The FastFlags aren't valid JSON. Is a comma or quote missing?"; }
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) return "The FastFlags must be one JSON object. Can you wrap them in { }?";
  return flags as FastFlags;
}

export const flagsText = (flags: FastFlags) => Object.keys(flags).length ? JSON.stringify(flags, null, 2) : "";

/** An allowlisted FastFlag, shown as the example. */
export const fastFlagsExample = '{ "DFIntDebugFRMQualityLevelOverride": 1 }';

/** Frame rate cap, graphics quality, and window size fields. `placeholder` describes an empty field. */
export function ClientSettingsFields({ draft, change, windows, placeholder }: { draft: ClientSettingsDraft; change: (draft: ClientSettingsDraft) => void; windows: boolean; placeholder: string }) {
  const id = useId();
  const field = (key: keyof ClientSettingsDraft, label: string, extra: object = {}) =>
    <Input id={`${id}-${key}`} type="number" inputMode="numeric" value={draft[key]} placeholder={placeholder} aria-label={label} className="tabular-nums"
      onChange={(event) => change({ ...draft, [key]: event.target.value })} {...extra} />;
  return <div className="grid gap-x-4 gap-y-2 sm:grid-cols-[auto_1fr] sm:items-center">
    <label htmlFor={`${id}-fpsCap`} className="text-sm">Frame rate cap</label>
    {field("fpsCap", "Frame rate cap", { min: 15, max: 240 })}
    <label htmlFor={`${id}-graphicsQuality`} className="text-sm">Graphics quality <span className="text-xs text-muted-foreground">1–10, 0 is automatic</span></label>
    {field("graphicsQuality", "Graphics quality", { min: 0, max: 10 })}
    {windows && <>
      <label htmlFor={`${id}-width`} className="text-sm">Window size <span className="text-xs text-muted-foreground">turns off fullscreen</span></label>
      <div className="flex items-center gap-2">{field("width", "Window width", { min: 320, max: 7680 })}<span className="text-muted-foreground" aria-hidden="true">×</span>{field("height", "Window height", { min: 180, max: 4320 })}</div>
    </>}
  </div>;
}

/** What an advanced setting writes, with links to verify it. */
export function AdvancedDetails({ writes, source, docs }: { writes: string[]; source: string; docs: { label: string; href: string }[] }) {
  const link = (label: string, href: string) => <Button key={href} variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => void bridge.openExternal(href)}>{label}<ExternalLink /></Button>;
  return <dl className="grid gap-x-4 gap-y-1.5 px-4 py-3 text-xs sm:grid-cols-[auto_1fr]">
    <dt className="text-muted-foreground">Writes</dt><dd className="min-w-0">{writes.map((path) => <code key={path} className="block font-mono break-all">{path}</code>)}</dd>
    <dt className="text-muted-foreground">Source</dt><dd>{link(source, `https://github.com/BakedAleska/Toolblox/blob/main/src-tauri/src/${source}`)}</dd>
    <dt className="text-muted-foreground">API docs</dt><dd className="flex flex-wrap gap-x-4">{docs.map(({ label, href }) => link(label, href))}</dd>
  </dl>;
}

/** Per-account client settings and FastFlags. Each applies over the defaults while its advanced setting is on. */
export function LaunchSettingsDialog({ account, state, open, close, saved }: { account: Account; state: AppState; open: boolean; close: () => void; saved: () => Promise<void> }) {
  const { settings } = state;
  const [draft, setDraft] = useState(() => draftFrom(account.clientSettings));
  const [flags, setFlags] = useState(() => flagsText(account.fastFlags));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setDraft(draftFrom(account.clientSettings)); setFlags(flagsText(account.fastFlags)); setError(""); setBusy(false); } }, [open, account]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const clientSettings = settingsFrom(draft);
    const fastFlags = flagsFrom(flags);
    if (typeof clientSettings === "string") { setError(clientSettings); return; }
    if (typeof fastFlags === "string") { setError(fastFlags); return; }
    setBusy(true);
    try { await bridge.setAccountLaunchSettings(account.id, clientSettings, fastFlags); await saved(); close(); }
    catch (reason) { setError(String(reason)); setBusy(false); }
  };
  return <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) close(); }}>
    <AlertDialogContent className="data-[size=default]:sm:max-w-md">
      <form className="contents" onSubmit={(event) => void submit(event)}>
        <AlertDialogHeader>
          <AlertDialogTitle>Launch settings for {accountName(account)}</AlertDialogTitle>
          <AlertDialogDescription>Applied before this account launches. Empty fields use the defaults in advanced settings.</AlertDialogDescription>
        </AlertDialogHeader>
        {settings.clientSettingsEnabled && <ClientSettingsFields draft={draft} change={(next) => { setDraft(next); setError(""); }} windows={state.platform === "windows"} placeholder="Default" />}
        {settings.fastFlagsEnabled && <div className="grid gap-1.5">
          <label htmlFor="account-fast-flags" className="text-sm">FastFlags <span className="text-xs text-muted-foreground">added to the defaults</span></label>
          <Textarea id="account-fast-flags" value={flags} rows={3} spellCheck={false} placeholder={fastFlagsExample} className="max-h-48 min-h-12 py-1.5 font-mono text-xs"
            onChange={(event) => { setFlags(event.target.value); setError(""); }} />
        </div>}
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={busy}>Cancel</AlertDialogCancel>
          <Button type="submit" disabled={busy}>{busy && <Spinner />}Save</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialogContent>
  </AlertDialog>;
}
