import { Copy, MoreHorizontal, Plus, Puzzle, RefreshCw, Settings as SettingsIcon, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { bridge } from "@/bridge";
import { cn } from "@/lib/utils";
import { EmptyState, IconButton, Panel, Screen, SectionTitle, Spinner, permissionSummary, type ScreenProps } from "@/shared";
import { useWidgetRegistry } from "@/widgets/host";
import type { CatalogueEntry, WidgetSummary } from "@/types";

const grid = "grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3";
const access = (permissions: string[]) => permissions.length ? `Permissions: ${permissionSummary(permissions)}.` : "No special permissions.";

export function Widgets({ state, refresh, navigate, notify, confirm }: ScreenProps) {
  const [working, setWorking] = useState<Set<string>>(new Set());
  const { settingsPages, errors } = useWidgetRegistry();
  const run = async (id: string, action: () => Promise<void>, failure: string) => {
    setWorking((current) => new Set(current).add(id));
    try { await action(); await refresh(); }
    catch (error) { notify(`${failure} Does retrying help? (${String(error)})`); }
    finally { setWorking((current) => { const next = new Set(current); next.delete(id); return next; }); }
  };
  const install = (entry: CatalogueEntry) => confirm({ title: `Install ${entry.name}?`, message: entry.permissions.length ? `Requested permissions: ${permissionSummary(entry.permissions)}. No other access is granted.` : "This widget requests no special permissions.", action: "Install", run: () => run(entry.id, () => bridge.installWidget(entry), `${entry.name} couldn't be installed.`) });

  return <Screen title="Widgets">
    {state.widgetErrors.map((error) => <Panel key={error} className="px-4 py-3 text-sm text-destructive ring-destructive/30">{error}</Panel>)}

    <section className="flex flex-col gap-2" aria-labelledby="installed-title">
      <SectionTitle><span id="installed-title">Installed</span></SectionTitle>
      {state.installedWidgets.length ? <div className={grid}>{state.installedWidgets.map((widget) => <InstalledCard key={widget.id} widget={widget} busy={working.has(widget.id)}
        open={() => navigate(`/widgets/${widget.id}`)}
        toggle={(enabled) => void run(widget.id, () => bridge.setWidgetEnabled(widget.id, enabled), `${widget.name} couldn't be ${enabled ? "enabled" : "disabled"}.`)}
        update={() => confirm({ title: `Update ${widget.name}?`, message: widget.availablePermissions?.length ? `Requested permissions: ${permissionSummary(widget.availablePermissions)}. No other access is granted.` : "This version requests no special permissions.", action: "Update", run: () => run(widget.id, () => bridge.updateWidget(widget.id), `${widget.name} couldn't be updated.`) })}
        error={errors.get(widget.id)}
        settings={widget.hasSettings || widget.canStartOnLaunch || settingsPages.has(widget.id) ? () => navigate(`/widgets/${widget.id}/settings`) : undefined}
        uninstall={() => confirm({ title: `Uninstall ${widget.name}?`, message: "Removes the widget and its settings from this device.", action: "Uninstall", danger: true, run: () => run(widget.id, () => bridge.uninstallWidget(widget.id), `${widget.name} couldn't be uninstalled.`) })} />)}</div>
        : <Panel><EmptyState icon={<Puzzle />} title="No widgets installed" text="Install a widget from the catalogue below." /></Panel>}
    </section>

    <section className="flex flex-col gap-2" aria-labelledby="catalogue-title">
      <SectionTitle><span id="catalogue-title">Catalogue</span></SectionTitle>
      {state.catalogueError ? <Panel className="flex items-center gap-3 px-4 py-3">
        <p className="flex-1 text-sm text-destructive">The catalogue failed to load. Is the connection working? ({state.catalogueError})</p>
        <Button variant="outline" size="sm" disabled={working.has("catalogue")} onClick={() => void run("catalogue", () => bridge.retryCatalogue(), "The catalogue failed to refresh.")}>{working.has("catalogue") ? <Spinner /> : <RefreshCw />}Retry</Button>
      </Panel>
        : state.catalogue.length ? <div className={grid}>{state.catalogue.map((entry) => <WidgetCard key={entry.id} name={entry.name} logoUrl={entry.logoUrl} meta={`v${entry.version}`} description={entry.description} permissions={entry.permissions}
          footer={<Button variant="outline" size="sm" className="ml-auto" disabled={working.has(entry.id)} onClick={() => install(entry)}>{working.has(entry.id) ? <Spinner /> : <Plus />}Install</Button>} />)}</div>
        : <p className="text-sm text-muted-foreground">All catalogue widgets are installed.</p>}
    </section>

    {state.channel === "canary" && <Panel className="space-y-2 px-4 py-3">
      <p className="text-xs text-muted-foreground">Development builds also load unpacked widgets from this folder.</p>
      <div className="flex items-center gap-2 rounded-lg bg-muted py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 truncate text-xs" title={state.widgetsPath}>{state.widgetsPath}</code>
        <IconButton label="Copy widgets folder path" size="icon-sm" onClick={() => void navigator.clipboard.writeText(state.widgetsPath).then(() => notify("Copied."))}><Copy /></IconButton>
      </div>
    </Panel>}
  </Screen>;
}

function WidgetCard({ name, logoUrl, meta, description, permissions, active = true, action, footer }: { name: string; logoUrl?: string; meta?: string; description: string; permissions: string[]; active?: boolean; action?: ReactNode; footer: ReactNode }) {
  return <Panel className="flex flex-col gap-3 p-4">
    <div className="flex items-start gap-3">
      <span className={cn("grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted text-muted-foreground transition-opacity", !active && "opacity-50")} aria-hidden="true">{logoUrl ? <img src={logoUrl} alt="" className="size-full object-cover" /> : <Puzzle className="size-5" />}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
      </div>
      {action}
    </div>
    <div className="flex-1 space-y-1">
      <p className="line-clamp-2 text-sm text-muted-foreground">{description || "No description."}</p>
      <p className="line-clamp-2 text-xs text-muted-foreground/80">{access(permissions)}</p>
    </div>
    <div className="flex items-center gap-2">{footer}</div>
  </Panel>;
}

function InstalledCard({ widget, busy, error, open, toggle, update, settings, uninstall }: { widget: WidgetSummary; busy: boolean; error?: string; open: () => void; toggle: (enabled: boolean) => void; update: () => void; settings?: () => void; uninstall: () => void }) {
  const updateAvailable = widget.availableVersion && widget.availableVersion !== widget.version;
  return <WidgetCard name={widget.name} logoUrl={widget.logoUrl} meta={widget.version ? `v${widget.version}` : undefined} description={widget.description} permissions={widget.permissions} active={widget.enabled}
    action={<Switch checked={widget.enabled} disabled={busy} onCheckedChange={(value) => toggle(value)} aria-label={`Enable ${widget.name}`} />}
    footer={<>
      <Button variant="outline" size="sm" disabled={!widget.enabled} onClick={open}>Open</Button>
      {error && <span className="min-w-0 truncate text-xs text-destructive" title={error}>Failed to load</span>}
      {updateAvailable && <Button variant="secondary" size="sm" disabled={busy} onClick={update}>{busy ? <Spinner /> : <RefreshCw />}Update to v{widget.availableVersion}</Button>}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={`More actions for ${widget.name}`} />}><MoreHorizontal /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          {settings && <DropdownMenuItem onClick={settings}><SettingsIcon />Settings</DropdownMenuItem>}
          <DropdownMenuItem variant="destructive" onClick={uninstall}><Trash2 />Uninstall</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>} />;
}
