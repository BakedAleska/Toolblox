import { MoreHorizontal, Plus, Puzzle, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { bridge } from "@/bridge";
import { cn } from "@/lib/utils";
import { Panel, Screen, SectionTitle, Spinner, permissionSummary, type ScreenProps, failure } from "@/shared";
import { WidgetContextMenu, WidgetMenuItems, useWidgetActions, type WidgetAction } from "@/screens/WidgetMenu";
import { useWidgetRegistry } from "@/widgets/host";
import type { CatalogueEntry, WidgetSummary } from "@/types";

const grid = "grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-list";
const access = (permissions: string[]) => permissions.length ? `Permissions: ${permissionSummary(permissions)}.` : "No special permissions.";

export function Widgets({ state, refresh, navigate, notify, confirm }: ScreenProps) {
  const [working, setWorking] = useState<Set<string>>(new Set());
  const { errors } = useWidgetRegistry();
  const run = async (id: string, action: () => Promise<void>, message: string) => {
    setWorking((current) => new Set(current).add(id));
    try { await action(); await refresh(); }
    catch (error) { notify(failure(`${message} Does retrying help?`, error)); }
    finally { setWorking((current) => { const next = new Set(current); next.delete(id); return next; }); }
  };
  const actions = useWidgetActions({ state, navigate, confirm }, run);
  const install = (entry: CatalogueEntry) => confirm({ scale: "small", title: `Install ${entry.name}?`, message: entry.permissions.length ? `Requested permissions: ${permissionSummary(entry.permissions)}. No other access is granted.` : "This widget requests no special permissions.", action: "Install", run: () => run(entry.id, () => bridge.installWidget(entry), `${entry.name} couldn't be installed.`) });

  return <Screen title="Widgets" className="gap-4">
    {state.widgetErrors.map((error) => <Panel key={error} className="px-4 py-3 text-sm text-destructive ring-destructive/30">{error}</Panel>)}

    {state.installedWidgets.length > 0 && <section className="flex min-h-[calc(100dvh-5rem)] flex-col gap-2" aria-labelledby="installed-title">
      <SectionTitle><span id="installed-title">Installed</span></SectionTitle>
      <div className={grid}>{state.installedWidgets.map((widget) => <InstalledCard key={widget.id} widget={widget} busy={working.has(widget.id)} actions={actions(widget)}
        open={() => navigate(`/widgets/${widget.id}`)}
        toggle={(enabled) => void run(widget.id, () => bridge.setWidgetEnabled(widget.id, enabled), `${widget.name} couldn't be ${enabled ? "enabled" : "disabled"}.`)}
        update={() => confirm({ scale: "small", title: `Update ${widget.name}?`, message: widget.availablePermissions?.length ? `Requested permissions: ${permissionSummary(widget.availablePermissions)}. No other access is granted.` : "This version requests no special permissions.", action: "Update", run: () => run(widget.id, () => bridge.updateWidget(widget.id), `${widget.name} couldn't be updated.`) })}
        error={errors.get(widget.id)} />)}</div>
    </section>}

    <section className="flex flex-col gap-2" aria-labelledby="catalogue-title">
      <SectionTitle><span id="catalogue-title">Catalogue</span>{!state.catalogueError && !state.catalogue.length && <span className="ml-2 font-normal text-muted-foreground/80">No widgets available</span>}</SectionTitle>
      {state.catalogueError ? <Panel className="flex items-center gap-3 px-4 py-3">
        <p className="flex-1 text-sm text-destructive">The catalogue couldn't be loaded. Is the connection working? ({state.catalogueError})</p>
        <Button variant="outline" size="sm" disabled={working.has("catalogue")} onClick={() => void run("catalogue", () => bridge.retryCatalogue(), "The catalogue couldn't be refreshed.")}>{working.has("catalogue") ? <Spinner /> : <RefreshCw />}Retry</Button>
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

function WidgetCard({ name, logoUrl, bannerUrl, meta, description, permissions, requirement, active = true, action, footer }: { name: string; logoUrl?: string; bannerUrl?: string; meta?: string; description: string; permissions: string[]; requirement?: ReactNode; active?: boolean; action?: ReactNode; footer: ReactNode }) {
  const [failed, setFailed] = useState(false);
  const [bannerFailed, setBannerFailed] = useState(false);
  const logo = logoUrl && !failed ? logoUrl : undefined;
  const banner = bannerUrl && !bannerFailed ? bannerUrl : undefined;
  return <Panel className="flex flex-col overflow-hidden">
    <div className={cn("relative h-20 overflow-hidden bg-muted transition-[filter]", !active && "grayscale")} aria-hidden="true">
      {banner ? <img src={banner} alt="" className="absolute inset-0 size-full object-cover" onError={() => setBannerFailed(true)} />
        : logo && <img src={logo} alt="" className="absolute inset-0 size-full scale-150 object-cover opacity-60 blur-2xl" />}
      <div className="absolute inset-0 bg-linear-to-t from-card to-transparent" />
    </div>
    <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
      <div className="-mt-8 flex items-end gap-3">
        <span className={cn("relative grid size-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-muted text-muted-foreground ring-4 ring-card transition-opacity", !active && "opacity-50")} aria-hidden="true">
          {logo ? <img src={logo} alt="" className="size-full object-cover" onError={() => setFailed(true)} /> : <Puzzle className="size-7" />}
        </span>
        <div className="ml-auto pb-1">{action}</div>
      </div>
      <div className="min-w-0">
        <p className="truncate font-semibold tracking-tight">{name}</p>
        {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
      </div>
      <div className="flex-1 space-y-1">
        <p className="line-clamp-2 text-sm text-muted-foreground">{description || "No description."}</p>
        <p className="line-clamp-2 text-xs text-muted-foreground/80">{access(permissions)}</p>
        {requirement}
      </div>
      <div className="flex items-center gap-2">{footer}</div>
    </div>
  </Panel>;
}

function InstalledCard({ widget, busy, error, actions, open, toggle, update }: { widget: WidgetSummary; busy: boolean; error?: string; actions: WidgetAction[]; open: () => void; toggle: (enabled: boolean) => void; update: () => void }) {
  const updateAvailable = widget.availableVersion && widget.availableVersion !== widget.version;
  return <WidgetContextMenu actions={actions}><WidgetCard name={widget.name} logoUrl={widget.logoUrl} bannerUrl={widget.bannerUrl} meta={widget.version ? `v${widget.version}` : undefined} description={widget.description} permissions={widget.permissions} active={widget.enabled}
    requirement={updateAvailable && widget.availableNeedsApp && <p className="text-xs text-warning">v{widget.availableVersion} requires Toolblox {widget.availableNeedsApp} or later.</p>}
    action={<Switch checked={widget.enabled} disabled={busy} onCheckedChange={(value) => toggle(value)} aria-label={`Enable ${widget.name}`} />}
    footer={<>
      <Button variant="outline" size="sm" disabled={!widget.enabled} onClick={open}>Open</Button>
      {error && <span className="min-w-0 truncate text-xs text-destructive" title={error}>Failed to load</span>}
      {updateAvailable && <Button variant="secondary" size="sm" disabled={busy || !!widget.availableNeedsApp} onClick={update}>{busy ? <Spinner /> : <RefreshCw />}Update to v{widget.availableVersion}</Button>}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={`More actions for ${widget.name}`} />}><MoreHorizontal /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40"><WidgetMenuItems actions={actions} /></DropdownMenuContent>
      </DropdownMenu>
    </>} /></WidgetContextMenu>;
}
