import { MoreHorizontal, Plus, Puzzle, RefreshCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { bridge } from "@/bridge";
import { cn } from "@/lib/utils";
import { lift } from "@/lib/motion";
import { Hint, Panel, Screen, SectionTitle, Spinner, permissionSummary, type ScreenProps, failure } from "@/shared";
import { WidgetContextMenu, WidgetMenuItems, useWidgetActions, type WidgetAction } from "@/screens/WidgetMenu";
import { useWidgetRegistry } from "@/widgets/host";
import type { CatalogueEntry, WidgetSummary } from "@/types";

const grid = "grid grid-cols-[repeat(auto-fill,16rem)] gap-list";
const access = (permissions: string[]) => permissions.length ? `Permissions: ${permissionSummary(permissions)}.` : "No special permissions.";

export function Widgets({ state, refresh, navigate, notify, done, confirm }: ScreenProps) {
  const [working, setWorking] = useState<Set<string>>(new Set());
  const { errors } = useWidgetRegistry();
  const run = async (id: string, action: () => Promise<void>, message: string, success?: string) => {
    setWorking((current) => new Set(current).add(id));
    try { await action(); if (success) done(success); await refresh(); }
    catch (error) { notify(failure(`${message} Does retrying help?`, error)); }
    finally { setWorking((current) => { const next = new Set(current); next.delete(id); return next; }); }
  };
  const actions = useWidgetActions({ state, navigate, confirm }, run);
  const catalogue = useRef<HTMLElement>(null);
  const stop = useRef(() => {});
  const { showAnimations, ignoreReducedMotion, widgetsOpenInstalled } = state.settings;
  const browsable = state.installedWidgets.length > 0 && state.catalogue.length > 0;
  const still = () => !showAnimations || (!ignoreReducedMotion && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const toCatalogue = () => {
    stop.current();
    const section = catalogue.current, container = section?.closest('[data-slot="screen"]')?.parentElement;
    if (!section || !container) return;
    if (still()) { section.scrollIntoView({ block: "start" }); return; }
    const from = container.scrollTop;
    const to = Math.min(container.scrollHeight - container.clientHeight, from + section.getBoundingClientRect().top - container.getBoundingClientRect().top - parseFloat(getComputedStyle(section).scrollMarginTop));
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / 550);
      container.scrollTop = from + (to - from) * (t < 0.5 ? 4 * t ** 3 : 1 - (2 - 2 * t) ** 3 / 2);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    stop.current = () => cancelAnimationFrame(frame);
  };
  useEffect(() => {
    const events = ["wheel", "pointerdown", "keydown", "touchstart"] as const;
    const cancel = () => { window.clearTimeout(timer); stop.current(); };
    events.forEach((name) => window.addEventListener(name, cancel, { passive: true }));
    const timer = widgetsOpenInstalled || !browsable ? 0 : window.setTimeout(toCatalogue, still() ? 0 : 800);
    return () => { cancel(); events.forEach((name) => window.removeEventListener(name, cancel)); };
  }, []);
  const install = (entry: CatalogueEntry) => confirm({ scale: "small", title: `Install ${entry.name}?`, message: entry.permissions.length ? `Requested permissions: ${permissionSummary(entry.permissions)}. No other access is granted.` : "This widget requests no special permissions.", action: "Install", run: () => run(entry.id, () => bridge.installWidget(entry), `${entry.name} couldn't be installed.`, `${entry.name} installed.`) });

  return <Screen title="Widgets" className="gap-4">
    {state.widgetErrors.map((error) => <Panel key={error} className="px-4 py-3 text-sm text-destructive ring-destructive/30">{error}</Panel>)}

    {state.installedWidgets.length > 0 && <section className="flex flex-col gap-2" aria-labelledby="installed-title">
      <SectionTitle><span id="installed-title">Installed</span></SectionTitle>
      <div className="-m-1 flex snap-x gap-list overflow-x-auto overflow-y-hidden p-1 pb-3 [scrollbar-width:thin]">{state.installedWidgets.map((widget) => <InstalledCard key={widget.id} widget={widget} busy={working.has(widget.id)} actions={actions(widget)}
        open={() => navigate(`/widgets/${widget.id}`)}
        toggle={(enabled) => void run(widget.id, () => bridge.setWidgetEnabled(widget.id, enabled), `${widget.name} couldn't be ${enabled ? "enabled" : "disabled"}.`, `${widget.name} ${enabled ? "enabled" : "disabled"}.`)}
        update={() => confirm({ scale: "small", title: `Update ${widget.name}?`, message: widget.availablePermissions?.length ? `Requested permissions: ${permissionSummary(widget.availablePermissions)}. No other access is granted.` : "This version requests no special permissions.", action: "Update", run: () => run(widget.id, () => bridge.updateWidget(widget.id), `${widget.name} couldn't be updated.`, `${widget.name} updated to v${widget.availableVersion}.`) })}
        error={errors.get(widget.id)} />)}</div>
    </section>}

    <section ref={catalogue} className={cn("flex scroll-mt-16 flex-col gap-2", browsable && "min-h-[calc(100dvh-5rem)]")} aria-labelledby="catalogue-title">
      <SectionTitle>{browsable ? <button type="button" id="catalogue-title" className="inline-flex items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50" onClick={toCatalogue}>Catalogue</button> : <span id="catalogue-title">Catalogue</span>}{!state.catalogueError && !state.catalogue.length && <span className="ml-2 font-normal text-muted-foreground/80">No widgets available</span>}</SectionTitle>
      {state.catalogueError ? <Panel className="flex items-center gap-3 px-4 py-3">
        <p className="flex-1 text-sm text-destructive">The catalogue couldn't be loaded. Is the connection working? ({state.catalogueError})</p>
        <Button variant="outline" size="sm" disabled={working.has("catalogue")} onClick={() => void run("catalogue", () => bridge.retryCatalogue(), "The catalogue couldn't be refreshed.", "Catalogue refreshed.")}>{working.has("catalogue") ? <Spinner /> : <RefreshCw />}Retry</Button>
      </Panel>
        : state.catalogue.length ? <div className={grid}>{state.catalogue.map((entry) => <WidgetCard key={entry.id} name={entry.name} logoUrl={entry.logoUrl} bannerUrl={entry.bannerUrl} meta={`v${entry.version}`} description={entry.description} permissions={entry.permissions}
          requirement={entry.minAppVersion && <Requirement version={entry.minAppVersion} supported={entry.supported} />}
          footer={<Button variant="outline" size="sm" className="ml-auto" disabled={working.has(entry.id) || !entry.supported} onClick={() => install(entry)}>{working.has(entry.id) ? <Spinner /> : <Plus />}Install</Button>} />)}</div>
        : null}
    </section>
  </Screen>;
}

/** The Toolblox version a widget needs. Says to update when this build is older. */
function Requirement({ version, supported }: { version: string; supported: boolean }) {
  return <p className={cn("text-xs", supported ? "text-muted-foreground/80" : "text-warning")}>Requires Toolblox {version} or later.{!supported && " Update Toolblox to install it."}</p>;
}

function WidgetCard({ name, logoUrl, bannerUrl, meta, description, permissions, requirement, active = true, action, footer, className }: { name: string; logoUrl?: string; bannerUrl?: string; meta?: string; description: string; permissions: string[]; requirement?: ReactNode; active?: boolean; action?: ReactNode; footer: ReactNode; className?: string }) {
  const [failed, setFailed] = useState(false);
  const [bannerFailed, setBannerFailed] = useState(false);
  const logo = logoUrl && !failed ? logoUrl : undefined;
  const banner = bannerUrl && !bannerFailed ? bannerUrl : undefined;
  const text = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  const [reading, setReading] = useState(false);
  useLayoutEffect(() => { const el = text.current; if (el) setClipped(el.scrollHeight > el.clientHeight + 1); }, [description]);
  return <Panel className={cn("group/card relative isolate flex aspect-square w-64 flex-col overflow-hidden", lift, className)}>
    <div className={cn("absolute inset-x-0 top-0 -z-10 h-16 overflow-hidden bg-muted mask-[linear-gradient(to_bottom,black,transparent)] transition-[filter]", !active && "grayscale")} aria-hidden="true">
      {banner && <img src={banner} alt="" className="size-full object-cover transition-transform duration-700 ease-enter group-hover/card:scale-110" onError={() => setBannerFailed(true)} />}
    </div>
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pt-8 pb-4">
      <div className="flex shrink-0 items-end gap-3">
        <span className={cn("grid size-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-muted text-muted-foreground ring-4 ring-card transition-[opacity,rotate,scale] duration-500 ease-spring group-hover/card:scale-105 group-hover/card:-rotate-3", !active && "opacity-50")} aria-hidden="true">
          {logo ? <img src={logo} alt="" className="size-full object-cover" onError={() => setFailed(true)} /> : <Puzzle className="size-7" />}
        </span>
        <div className="ml-auto pb-1">{action}</div>
      </div>
      <div className="min-w-0 shrink-0">
        <p className="truncate font-semibold tracking-tight">{name}</p>
        {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-hidden">
        <div className="group/text relative">
          <p ref={text} className={cn("line-clamp-2 text-sm text-muted-foreground", clipped && "transition-colors group-hover/text:text-foreground")}>{description || "No description."}</p>
          {clipped && <button type="button" className="absolute inset-0 cursor-pointer rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label={`Read the full description of ${name}`} onClick={() => setReading(true)} />}
        </div>
        <p className="line-clamp-1 text-xs text-muted-foreground/80">{access(permissions)}</p>
        {requirement}
      </div>
      <div className="flex shrink-0 items-center gap-2">{footer}</div>
    </div>
    {reading && <div className="absolute inset-0 z-10 flex flex-col gap-2 bg-card p-4" role="region" aria-label={`${name} description`} onKeyDown={(event) => { if (event.key === "Escape") setReading(false); }}>
      <div className="flex shrink-0 items-center gap-2">
        <p className="min-w-0 flex-1 truncate font-semibold tracking-tight">{name}</p>
        <Button variant="ghost" size="icon-sm" autoFocus aria-label="Close description" onClick={() => setReading(false)}><X /></Button>
      </div>
      <p className="-mr-2 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2 text-sm/relaxed whitespace-pre-line text-muted-foreground [scrollbar-width:thin]">{description}</p>
    </div>}
  </Panel>;
}

function InstalledCard({ widget, busy, error, actions, open, toggle, update }: { widget: WidgetSummary; busy: boolean; error?: string; actions: WidgetAction[]; open: () => void; toggle: (enabled: boolean) => void; update: () => void }) {
  const updateAvailable = widget.availableVersion && widget.availableVersion !== widget.version;
  return <WidgetContextMenu actions={actions}><WidgetCard className="shrink-0 snap-start" name={widget.name} logoUrl={widget.logoUrl} bannerUrl={widget.bannerUrl} meta={widget.version ? `v${widget.version}` : undefined} description={widget.description} permissions={widget.permissions} active={widget.enabled}
    requirement={updateAvailable && widget.availableNeedsApp && <p className="text-xs text-warning">v{widget.availableVersion} requires Toolblox {widget.availableNeedsApp} or later.</p>}
    action={<Switch checked={widget.enabled} disabled={busy} onCheckedChange={(value) => toggle(value)} aria-label={`Enable ${widget.name}`} />}
    footer={<>
      <Button variant="outline" size="sm" disabled={!widget.enabled} onClick={open}>Open</Button>
      {error && <Hint label={error}><span tabIndex={0} className="min-w-0 truncate rounded-sm text-xs text-destructive outline-none focus-visible:ring-3 focus-visible:ring-ring/50">Failed to load</span></Hint>}
      {updateAvailable && <Button variant="secondary" size="sm" disabled={busy || !!widget.availableNeedsApp} onClick={update}>{busy ? <Spinner /> : <RefreshCw />}Update to v{widget.availableVersion}</Button>}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={`More actions for ${widget.name}`} />}><MoreHorizontal /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40"><WidgetMenuItems actions={actions} /></DropdownMenuContent>
      </DropdownMenu>
    </>} /></WidgetContextMenu>;
}
