import { ExternalLink, LayoutDashboard, Puzzle, Settings as SettingsIcon, ShieldAlert, Users } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import "./index.css";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { bridge } from "@/bridge";
import { cn } from "@/lib/utils";
import { SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MAX, clampSidebarWidth, parsePlaceId, stepSidebarWidth } from "@/logic";
import { Accounts } from "@/screens/Accounts";
import { Dashboard } from "@/screens/Dashboard";
import { SettingsScreen } from "@/screens/Settings";
import { Widgets } from "@/screens/Widgets";
import { EmptyState, IconButton, Panel, Screen, Spinner, SwitchRow, WidgetFrame, type ConfirmRequest, type PlaceRequest, type ScreenProps } from "@/shared";
import { WidgetBoundary, WidgetSlot, syncWidgetHost, syncWidgetModules, useWidgetRegistry, type CoreScreen } from "@/widgets/host";
import type { AppRoute, AppState, RecentPlace, Settings, StartupStatus, ThemeMode, WidgetSummary } from "@/types";

const coreRoutes = [
  { route: "/" as const, label: "Dashboard", icon: LayoutDashboard },
  { route: "/accounts" as const, label: "Accounts", icon: Users },
  { route: "/widgets" as const, label: "Widgets", icon: Puzzle },
  { route: "/settings" as const, label: "Settings", icon: SettingsIcon },
];

const routeFromHash = (): AppRoute => {
  const value = window.location.hash.slice(1) || "/";
  return value === "/" || value === "/accounts" || value === "/widgets" || value === "/settings" || value.startsWith("/widgets/")
    ? (value as AppRoute) : "/";
};

const sidebarWidthKey = "toolblox-sidebar-width";
const readSidebarWidth = () => {
  try { const saved = Number(localStorage.getItem(sidebarWidthKey)); return saved ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT; }
  catch { return SIDEBAR_DEFAULT; }
};

/** Applies the `dark` class from the saved mode, following the OS while the mode is "system". */
function useTheme(mode: ThemeMode = "system") {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", mode === "dark" || (mode === "system" && media.matches));
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);
}

function App() {
  const [startup, setStartup] = useState<StartupStatus>();
  const [state, setState] = useState<AppState>();
  const [loadError, setLoadError] = useState("");
  const [route, setRoute] = useState<AppRoute>(routeFromHash);
  const [toast, setToast] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [placeRequest, setPlaceRequest] = useState<PlaceRequest>();
  const [placeOpen, setPlaceOpen] = useState(false);
  useTheme(state?.settings.themeMode);
  const registry = useWidgetRegistry();
  const host = useRef<Parameters<typeof syncWidgetHost>>(undefined);
  useEffect(() => { if (host.current) syncWidgetHost(...host.current); });
  const widgetsKey = state ? JSON.stringify([state.safeMode, state.installedWidgets.map(({ id, enabled, moduleUrl }) => [id, enabled, moduleUrl])]) : "";
  useEffect(() => { if (state) void syncWidgetModules(state.installedWidgets, state.safeMode); }, [widgetsKey]);

  const load = async () => {
    setLoadError("");
    try { setState(await bridge.getAppState()); }
    catch (error) { setLoadError(`Toolblox failed to load. Does restarting it help? (${String(error)})`); }
  };

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await bridge.startupStatus();
        if (cancelled) return;
        setStartup(status);
        if (status.phase === "ready") await load();
      } catch (error) {
        if (!cancelled) setStartup({ phase: "failed", message: `The updater failed to start. Does reopening Toolblox help? (${String(error)})` });
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      if (startup?.phase === "checking" || startup?.phase === "installing" || !startup) void poll();
    }, 500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [startup?.phase]);
  useEffect(() => {
    if (startup?.phase !== "ready") return;
    let active = true;
    let timer = window.setTimeout(async function poll() {
      await load();
      if (active) timer = window.setTimeout(poll, 60_000);
    }, 60_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => { active = false; window.clearTimeout(timer); window.removeEventListener("focus", onFocus); };
  }, [startup?.phase]);
  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 4000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const navigate = (next: AppRoute) => { window.location.hash = next; setRoute(next); };
  if (!startup || startup.phase !== "ready") return <UpdaterGate status={startup} />;
  if (!state) return <main className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground" aria-live="polite">
    {loadError ? <><p className="max-w-sm text-destructive">{loadError}</p><Button variant="outline" onClick={() => void load()}>Retry</Button></> : <><Spinner className="size-5" />Loading Toolblox…</>}
  </main>;

  const patchSettings = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const settings = { ...state.settings, [key]: value };
    setState((current) => current ? { ...current, settings } : current);
    try { await bridge.saveSettings(settings); }
    catch (error) { setToast(`The setting wasn't saved. Does retrying help? (${String(error)})`); void load(); }
  };
  const launch = async (accountIds: number[], placeId?: string) => {
    try { await bridge.joinAccounts(accountIds, placeId); await load(); }
    catch (error) { setToast(`Join failed. Is Roblox installed and the account signed in? (${String(error)})`); }
  };
  const askPlace = (request: PlaceRequest) => { setPlaceRequest(request); setPlaceOpen(true); };
  const join = (accountIds: number[], placeId?: string) => {
    if (placeId) { void launch(accountIds, placeId); return; }
    const needsPlace = !state.settings.placeId && accountIds.some((id) => !state.accounts.find((account) => account.id === id)?.placeId);
    if (!needsPlace) { void launch(accountIds); return; }
    askPlace({ title: "Set default place", description: "Enter a Roblox game link or place ID. It can be changed on the Accounts page.", action: "Save and join",
      run: async (placeId) => { await patchSettings("placeId", placeId); await launch(accountIds); } });
  };
  const props: ScreenProps = { state, refresh: load, navigate, notify: setToast, confirm: (request) => { setConfirm(request); setConfirmOpen(true); }, join, askPlace, patchSettings };
  host.current = [state, { navigate, notify: setToast, refresh: load, join }];

  const replaced = (name: CoreScreen) => {
    const entry = registry.screens.get(name);
    return entry && <WidgetBoundary widgetId={entry.widgetId}><entry.value /></WidgetBoundary>;
  };
  let screen: ReactNode;
  if (route === "/") screen = replaced("dashboard") || <Dashboard {...props} />;
  else if (route === "/accounts") screen = replaced("accounts") || <Accounts {...props} />;
  else if (route === "/widgets") screen = replaced("widgets") || <Widgets {...props} />;
  else if (route === "/settings") screen = <SettingsScreen {...props} />;
  else {
    const match = route.match(/^\/widgets\/([\w-]+)(\/settings)?$/);
    const widget = match ? state.installedWidgets.find(({ id }) => id === match[1]) : undefined;
    screen = !widget?.enabled || state.safeMode ? <NotFound navigate={navigate} />
      : match?.[2] ? <WidgetSettings widget={widget} {...props} />
      : <WidgetHost widget={widget} navigate={navigate} />;
  }

  return <TooltipProvider delay={400}>
    <div className={cn("flex h-full", state.settings.sidebarPosition === "right" && "flex-row-reverse")}>
      <Sidebar state={state} route={route} navigate={navigate} />
      <div className="relative flex min-w-0 flex-1 flex-col">
        {state.safeMode && <div className="flex items-center gap-3 border-b bg-warning/10 px-6 py-2 text-sm" role="status">
          <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
          <span className="flex-1">Safe mode. Widgets are off for this session.</span>
          <Button variant="outline" size="sm" onClick={() => void bridge.restartApp(false)}>Restart normally</Button>
        </div>}
        <main key={route} className="min-h-0 flex-1 animate-in duration-200 fade-in-0 slide-in-from-bottom-1" id="main-content">{screen}</main>
        {toast && <div className="absolute inset-x-4 bottom-4 z-50 mx-auto w-fit max-w-[520px] animate-in rounded-lg bg-foreground px-4 py-3 text-sm text-background shadow-lg fade-in-0 slide-in-from-bottom-2" role="status">{toast}</div>}
      </div>
      {placeRequest && <PlaceDialog request={placeRequest} recentPlaces={state.recentPlaces} open={placeOpen} close={() => setPlaceOpen(false)} />}
      {confirm && <ConfirmDialog request={confirm} open={confirmOpen} close={() => setConfirmOpen(false)} notify={setToast} />}
    </div>
  </TooltipProvider>;
}

function UpdaterGate({ status }: { status?: StartupStatus }) {
  const [retrying, setRetrying] = useState(false);
  const failed = status?.phase === "failed";
  return <main className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center" aria-live={failed ? "assertive" : "polite"}>
    <img src="/assets/logo.svg" alt="" width="56" height="56" />
    <div className="max-w-sm space-y-1">
      <h1 className="text-base font-semibold">{failed ? "Update verification failed" : status?.phase === "installing" ? `Installing Toolblox ${status.version}` : "Checking for updates"}</h1>
      <p className="text-sm text-muted-foreground">{failed ? status.message : "Toolblox opens only after the latest verified release is installed."}</p>
    </div>
    {failed ? <div className="flex gap-2">
      <Button variant="outline" onClick={() => void bridge.quitStartup()}>Quit</Button>
      <Button disabled={retrying} onClick={() => { setRetrying(true); void bridge.retryStartupUpdate().then(() => bridge.startupStatus()).then(() => window.location.reload()).finally(() => setRetrying(false)); }}>{retrying && <Spinner />}Retry</Button>
    </div> : <Spinner className="size-5 text-muted-foreground" />}
  </main>;
}

function Sidebar({ state, route, navigate }: { state: AppState; route: AppRoute; navigate: (route: AppRoute) => void }) {
  const [width, setWidth] = useState(readSidebarWidth);
  const [dragging, setDragging] = useState(false);
  const collapsed = width === SIDEBAR_COLLAPSED;
  const right = state.settings.sidebarPosition === "right";
  const persist = (next: number) => { setWidth(next); try { localStorage.setItem(sidebarWidthKey, String(next)); } catch { /* The width falls back to the default. */ } };
  useEffect(() => {
    if (!dragging) return;
    const { style } = document.body;
    style.cursor = "col-resize"; style.userSelect = "none";
    return () => { style.cursor = ""; style.userSelect = ""; };
  }, [dragging]);
  const item = (target: AppRoute, label: string, icon: ReactNode, enabled = true) => <Tooltip key={target}>
    <TooltipTrigger render={<button className={cn(
      "flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
      route === target && "bg-sidebar-accent font-medium text-foreground hover:bg-sidebar-accent",
    )} aria-current={route === target ? "page" : undefined} disabled={!enabled} onClick={() => navigate(target)} aria-label={label} />}>
      {icon}{!collapsed && <span className="truncate">{label}</span>}
    </TooltipTrigger>
    <TooltipContent side={right ? "left" : "right"} className={cn(!collapsed && "hidden")}>{enabled ? label : `${label} is disabled`}</TooltipContent>
  </Tooltip>;
  return <aside style={{ width }} className={cn("relative flex shrink-0 flex-col gap-1 bg-sidebar p-2", !dragging && "transition-[width] duration-150", right ? "border-l border-sidebar-border" : "border-r border-sidebar-border")} aria-label="Main navigation">
    <div className="mb-2 flex h-10 items-center gap-2 overflow-hidden px-1.5">
      <img src="/assets/logo.svg" alt="" width="24" height="24" className="shrink-0" />
      {!collapsed && <span className="truncate font-semibold tracking-tight">Toolblox</span>}
    </div>
    <nav className="flex flex-1 flex-col gap-0.5 overflow-hidden">
      {coreRoutes.map(({ route: target, label, icon: Icon }) => item(target, label, <Icon aria-hidden="true" />))}
      {state.installedWidgets.length > 0 && (collapsed ? <hr className="my-2 border-sidebar-border" /> : <p className="mt-4 mb-1 truncate px-2.5 text-xs text-muted-foreground">Widgets</p>)}
      {state.installedWidgets.map((widget) => item(`/widgets/${widget.id}`, widget.name, <Puzzle aria-hidden="true" />, widget.enabled))}
    </nav>
    <div className="flex items-center gap-1 overflow-hidden px-0.5">
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon" onClick={() => void bridge.openExternal("https://github.com/BakedAleska/Toolblox")} aria-label="GitHub repository" />}>
          <img src="/assets/github.svg" alt="" width="16" height="16" className="opacity-60 dark:invert" />
        </TooltipTrigger>
        <TooltipContent>GitHub</TooltipContent>
      </Tooltip>
      {!collapsed && <span className="truncate text-xs text-muted-foreground" title={state.channel === "canary" ? "Running from a source checkout." : "The installed, publicly released build."}>v{state.version}{state.channel === "canary" ? "-canary" : ""}</span>}
    </div>
    <WidgetSlot name="sidebar.footer" props={{ collapsed }} />
    <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuemin={SIDEBAR_COLLAPSED} aria-valuemax={SIDEBAR_MAX} aria-valuenow={width} tabIndex={0}
      className={cn("group absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-none", right ? "-left-1" : "-right-1")}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); }}
      onPointerMove={(event) => { if (dragging) setWidth(clampSidebarWidth(right ? window.innerWidth - event.clientX : event.clientX)); }}
      onPointerUp={() => { setDragging(false); persist(width); }}
      onDoubleClick={() => persist(collapsed ? SIDEBAR_DEFAULT : SIDEBAR_COLLAPSED)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        persist(stepSidebarWidth(width, (event.key === "ArrowRight") !== right));
      }}>
      <span className={cn("absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover:bg-ring/60 group-focus-visible:bg-ring", dragging && "bg-ring")} />
    </div>
  </aside>;
}

function WidgetHost({ widget, navigate }: { widget: WidgetSummary; navigate: (route: AppRoute) => void }) {
  const { pages, settingsPages } = useWidgetRegistry();
  const Page = pages.get(widget.id);
  const hasSettings = widget.hasSettings || widget.canStartOnLaunch || settingsPages.has(widget.id);
  return <Screen title={widget.name} className="h-full" actions={hasSettings && <IconButton label={`${widget.name} settings`} onClick={() => navigate(`/widgets/${widget.id}/settings`)}><SettingsIcon /></IconButton>}>
    {Page ? <WidgetBoundary widgetId={widget.id}><Page /></WidgetBoundary>
      : widget.hasPageFrame ? <WidgetFrame widget={widget} surface="main" title={widget.name} />
      : <EmptyState icon={<Puzzle />} title="No page" text="This widget adds features to other parts of Toolblox." />}
  </Screen>;
}

/** Settings for one widget. Kept apart from Toolblox's own Settings page. */
function WidgetSettings({ widget, navigate, refresh, notify }: ScreenProps & { widget: WidgetSummary }) {
  const { settingsPages, pages } = useWidgetRegistry();
  const Custom = settingsPages.get(widget.id);
  const empty = !Custom && !widget.hasSettings && !widget.canStartOnLaunch;
  return <Screen title={`${widget.name} settings`} actions={(pages.has(widget.id) || widget.hasPageFrame) && <Button variant="ghost" size="sm" onClick={() => navigate(`/widgets/${widget.id}`)}>Open widget</Button>}>
    {widget.canStartOnLaunch && <Panel><SwitchRow title="Start with Toolblox" description={`Run ${widget.name} when Toolblox starts.`} checked={widget.startOnLaunch}
      change={(value) => void bridge.setWidgetStartOnLaunch(widget.id, value).then(refresh).catch((error) => notify(`The startup setting wasn't saved. Does retrying help? (${String(error)})`))} /></Panel>}
    {Custom && <WidgetBoundary widgetId={widget.id}><Custom /></WidgetBoundary>}
    {widget.hasSettings && <WidgetFrame widget={widget} surface="settings" title={`${widget.name} settings`} />}
    {empty && <EmptyState icon={<SettingsIcon />} title="No settings" text="This widget has no settings." />}
  </Screen>;
}

function NotFound({ navigate }: { navigate: (route: AppRoute) => void }) {
  return <EmptyState icon={<ExternalLink />} title="Page unavailable" text="This widget is disabled or uninstalled." action={<Button onClick={() => navigate("/")}>Go to Dashboard</Button>} />;
}

function PlaceDialog({ request, recentPlaces, open, close }: { request: PlaceRequest; recentPlaces: RecentPlace[]; open: boolean; close: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setValue(""); setError(""); setBusy(false); } }, [open]);
  const save = async (placeId: string) => { setBusy(true); await request.run(placeId); close(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const placeId = parsePlaceId(value);
    if (!placeId) { setError("No place ID found. Is the link complete?"); return; }
    setBusy(true);
    const exists = await bridge.placeExists(placeId).catch(() => true);
    setBusy(false);
    if (exists) void save(placeId);
    else { setValue(""); setError(`Place ${placeId} doesn't exist. Is the ID correct?`); }
  };
  return <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) close(); }}>
    <AlertDialogContent>
      <form className="contents" onSubmit={(event) => void submit(event)}>
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
          <AlertDialogDescription>{request.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <Input autoFocus value={value} onChange={(event) => { setValue(event.target.value); setError(""); }} placeholder="roblox.com/games/1818/… or 1818" className="font-mono"
            aria-label="Place ID or Roblox game link" aria-invalid={!!error} aria-describedby={error ? "place-dialog-error" : undefined} />
          {error && <p id="place-dialog-error" className="text-xs text-destructive">{error}</p>}
        </div>
        {recentPlaces.length > 0 && <div className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">Recent places</p>
          <div className="flex flex-wrap gap-1.5">
            {recentPlaces.map((place) => <Button key={place.placeId} type="button" variant="outline" size="sm" disabled={busy} className="max-w-full" title={place.placeId} onClick={() => void save(place.placeId)}>
              <span className="truncate">{place.name || place.placeId}</span>
            </Button>)}
          </div>
        </div>}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={busy}>Cancel</AlertDialogCancel>
          <Button type="submit" disabled={busy || !value.trim()}>{busy && <Spinner />}{request.action}</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialogContent>
  </AlertDialog>;
}

function ConfirmDialog({ request, open, close, notify }: { request: ConfirmRequest; open: boolean; close: () => void; notify: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setBusy(false); }, [open]);
  const submit = async () => { setBusy(true); try { await request.run(); close(); } catch (error) { notify(`The action failed. Does retrying help? (${String(error)})`); setBusy(false); } };
  return <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) close(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{request.title}</AlertDialogTitle>
        <AlertDialogDescription>{request.message}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <Button variant={request.danger ? "destructive" : "default"} onClick={() => void submit()} disabled={busy}>{busy && <Spinner />}{request.action}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

export default App;
