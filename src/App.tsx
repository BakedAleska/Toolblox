import { AppWindow, ArrowLeft, ExternalLink, LayoutDashboard, Minimize2, Monitor, Moon, PictureInPicture2, Proportions, Puzzle, Settings as SettingsIcon, ShieldAlert, Sun, Users, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./index.css";
import { Button } from "@/components/ui/button";
import { Toaster, parseToast, useToasts, type ToastKind } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { bridge, isDemo } from "@/bridge";
import { pageOf, useCustomTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampSidebarWidth, parsePlaceId, stepSidebarWidth } from "@/logic";
import { Accounts } from "@/screens/Accounts";
import { Dashboard } from "@/screens/Dashboard";
import { MiniWindow } from "@/screens/Mini";
import { PlaceSearch } from "@/screens/PlaceSearch";
import { CustomCssScreen } from "@/screens/Themes";
import { LogScreen, SettingsScreen, WidgetSettingsTab } from "@/screens/Settings";
import { WidgetContextMenu, useWidgetActions, useWidgetHasSettings } from "@/screens/WidgetMenu";
import { Widgets } from "@/screens/Widgets";
import { EmptyState, IconButton, Modal, PlaceInput, Screen, ScreenTools, Spinner, WidgetFrame, type ConfirmRequest, type PlaceRequest, type ScreenProps, failure } from "@/shared";
import { WidgetBoundary, WidgetPageContext, WidgetSlot, syncWidgetHost, syncWidgetModules, useWidgetRegistry, type CoreScreen } from "@/widgets/host";
import type { AppRoute, AppState, RecentPlace, Settings, StartupStatus, ThemeMode, WidgetSummary } from "@/types";

const coreRoutes = [
  { route: "/" as const, label: "Dashboard", icon: LayoutDashboard },
  { route: "/accounts" as const, label: "Accounts", icon: Users },
  { route: "/widgets" as const, label: "Widgets", icon: Puzzle },
  { route: "/settings" as const, label: "Settings", icon: SettingsIcon },
];

const routeFromHash = (): AppRoute => {
  const value = window.location.hash.slice(1) || "/";
  return value === "/" || value === "/accounts" || value === "/accounts/places" || value === "/widgets" || value === "/settings" || value === "/settings/css" || value === "/settings/log" || value.startsWith("/widgets/")
    ? (value as AppRoute) : "/";
};

const sidebarWidthKey = "toolblox-sidebar-width";
const readSidebarWidth = () => {
  try { const saved = Number(localStorage.getItem(sidebarWidthKey)); return saved ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT; }
  catch { return SIDEBAR_DEFAULT; }
};

/** The website's color scheme, which stands in for the OS one when the demo is embedded there. */
let siteDark: boolean | undefined;
const embedded = isDemo() && window.parent !== window;

/** Sets `data-motion` to "none" when animations are off, or "reduced" when the OS asks for reduced motion and it isn't ignored. */
function useMotion(show: boolean, ignoreReduced: boolean) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      const motion = !show ? "none" : media.matches && !ignoreReduced ? "reduced" : undefined;
      if (motion) document.documentElement.dataset.motion = motion;
      else delete document.documentElement.dataset.motion;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [show, ignoreReduced]);
}

/** Applies the `dark` class from the saved mode, following the OS while the mode is "system". */
function useTheme(mode: ThemeMode = "system") {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", mode === "dark" || (mode === "system" && (siteDark ?? media.matches)));
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.type !== "toolblox:scheme") return;
      siteDark = event.data.dark === true;
      apply();
    };
    apply();
    media.addEventListener("change", apply);
    if (embedded) { window.addEventListener("message", onMessage); window.parent.postMessage({ type: "toolblox:ready" }, window.location.origin); }
    return () => { media.removeEventListener("change", apply); window.removeEventListener("message", onMessage); };
  }, [mode]);
}

function App() {
  const [startup, setStartup] = useState<StartupStatus>();
  const [state, setState] = useState<AppState>();
  const [loadError, setLoadError] = useState("");
  const [route, setRoute] = useState<AppRoute>(routeFromHash);
  const toasts = useToasts();
  const [mini, setMini] = useState(false);
  const miniRef = useRef(false);
  /** Shows a message as a toast, or as a system notification while the mini window is open. */
  const notify = useCallback((message: string, kind?: ToastKind) => {
    if (!miniRef.current) { toasts.notify(message, kind); return; }
    const { title, description } = parseToast(message, kind);
    void bridge.showNotification(title, description).catch(() => undefined);
  }, [toasts.notify]);
  const setMiniMode = (open: boolean) => {
    miniRef.current = open;
    setMini(open);
    if (!open) void bridge.setMiniWindow(null).catch((error) => notify(failure(`The window wasn't restored. Does retrying help?`, error)));
  };
  const [joining, setJoining] = useState<number[]>([]);
  const [confirm, setConfirm] = useState<ConfirmRequest>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [placeRequest, setPlaceRequest] = useState<PlaceRequest>();
  const [placeOpen, setPlaceOpen] = useState(false);
  useTheme(state?.settings.themeMode);
  useMotion(state?.settings.showAnimations ?? true, state?.settings.ignoreReducedMotion ?? false);
  const themes = useCustomTheme(startup?.phase === "ready", !state?.safeMode, notify);
  const registry = useWidgetRegistry();
  const host = useRef<Parameters<typeof syncWidgetHost>>(undefined);
  useEffect(() => { if (host.current) syncWidgetHost(...host.current); });
  const widgetsKey = state ? JSON.stringify([state.safeMode, state.popouts, state.installedWidgets.map(({ id, enabled, moduleUrl }) => [id, enabled, moduleUrl])]) : "";
  /** A widget in its own window runs its module there, so the main window unloads it until the window closes. */
  useEffect(() => { if (state) void syncWidgetModules(state.installedWidgets.filter(({ id }) => !state.popouts.includes(id)), state.safeMode); }, [widgetsKey]);
  useEffect(() => bridge.onPopoutsChanged((popouts) => setState((current) => current && { ...current, popouts })), []);
  useEffect(() => bridge.onWidgetsChanged(() => void load()), []);

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

  const navigate = (next: AppRoute) => { window.location.hash = next; setRoute(next); };
  if (!startup || startup.phase !== "ready") return <UpdaterGate status={startup} />;
  if (!state) return <main className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground" aria-live="polite">
    {loadError ? <><p className="max-w-sm text-destructive">{loadError}</p><Button variant="outline" onClick={() => void load()}>Retry</Button></> : <><Spinner className="size-5" />Loading Toolblox…</>}
  </main>;

  const patchSettings = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const settings = { ...state.settings, [key]: value };
    setState((current) => current ? { ...current, settings } : current);
    try { await bridge.saveSettings(settings); }
    catch (error) { notify(failure(`The setting wasn't saved. Does retrying help?`, error)); void load(); }
  };
  const launch = async (accountIds: number[], placeId?: string) => {
    setJoining(accountIds);
    try { await bridge.joinAccounts(accountIds, placeId); await load(); }
    catch (error) { notify(failure(`Join failed. Is Roblox installed and the account signed in?`, error)); await load(); }
    finally { setJoining([]); }
  };
  const askPlace = (request: PlaceRequest) => { setPlaceRequest(request); setPlaceOpen(true); };
  const join = (accountIds: number[], placeId?: string) => {
    if (placeId) { void launch(accountIds, placeId); return; }
    const needsPlace = !state.settings.placeId && accountIds.some((id) => !state.accounts.find((account) => account.id === id)?.placeId);
    if (!needsPlace) { void launch(accountIds); return; }
    if (miniRef.current) { notify("Joining requires a default place. Is one set on the Accounts page?"); return; }
    navigate("/accounts/places");
  };
  const signIn = async (accountId: number) => {
    try { await bridge.beginRobloxLogin(accountId); await load(); }
    catch (error) { notify(failure(`Sign-in didn't complete. Was the sign-in window closed?`, error)); }
  };
  const props: ScreenProps = { state, refresh: load, navigate, notify, confirm: (request) => { setConfirm(request); setConfirmOpen(true); }, join, joining, signIn, askPlace, patchSettings, openMini: () => setMiniMode(true) };
  host.current = [state, { navigate, notify, refresh: load, join }];
  if (mini) return <TooltipProvider delay={400}><MiniWindow state={state} join={join} joining={joining} signIn={signIn} notify={notify} exit={() => setMiniMode(false)} /></TooltipProvider>;

  const replaced = (name: CoreScreen) => {
    const entry = registry.screens.get(name);
    return entry && <WidgetBoundary widgetId={entry.widgetId}><entry.value /></WidgetBoundary>;
  };
  let screen: ReactNode;
  if (route === "/") screen = replaced("dashboard") || <Dashboard {...props} />;
  else if (route === "/accounts") screen = replaced("accounts") || <Accounts {...props} />;
  else if (route === "/accounts/places") screen = <PlaceSearch {...props} />;
  else if (route === "/widgets") screen = replaced("widgets") || <Widgets {...props} />;
  else if (route === "/settings") screen = <SettingsScreen {...props} themes={themes} />;
  else if (route === "/settings/css") screen = <CustomCssScreen {...props} themes={themes} />;
  else if (route === "/settings/log") screen = <LogScreen {...props} />;
  else {
    const match = route.match(/^\/widgets\/([\w-]+)(\/settings)?$/);
    const widget = match ? state.installedWidgets.find(({ id }) => id === match[1]) : undefined;
    screen = !widget?.enabled || state.safeMode ? <NotFound navigate={navigate} />
      : match?.[2] ? <SettingsScreen {...props} themes={themes} widgetId={widget.id} />
      : <WidgetHost widget={widget} {...props} />;
  }

  return <TooltipProvider delay={400}><ScreenTools.Provider value={(tools, iconTools) => <HeaderTools themeMode={state.settings.themeMode} patchSettings={patchSettings} openMini={props.openMini} icons={iconTools} extra={tools} />}>
    <div className={cn("relative flex h-full", state.settings.sidebarPosition === "right" && "flex-row-reverse")}>
      <Sidebar {...props} route={route} />
      <div className="relative flex min-w-0 flex-1 flex-col">
        {state.safeMode && <div className="flex items-center gap-3 border-b bg-warning/10 px-6 py-2 text-sm" role="status">
          <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
          <span className="flex-1">Safe mode is on. Widgets and the custom theme are disabled for this session.</span>
          <Button variant="outline" size="sm" onClick={() => void bridge.restartApp(false)}>Restart normally</Button>
        </div>}
        <main key={route} data-page={pageOf(route)} className="min-h-0 flex-1 animate-in duration-200 fade-in-0 slide-in-from-bottom-1" id="main-content">{screen}</main>
      </div>
      {placeRequest && <PlaceDialog request={placeRequest} recentPlaces={state.recentPlaces} open={placeOpen} close={() => setPlaceOpen(false)}
        forget={(placeId) => bridge.forgetRecentPlace(placeId).then(load).catch((error) => notify(failure(`The place wasn't removed. Does retrying help?`, error)))} />}
      {confirm && <ConfirmDialog request={confirm} open={confirmOpen} close={() => setConfirmOpen(false)} notify={notify} />}
      <Toaster {...toasts} side={state.settings.sidebarPosition === "right" ? "left" : "right"} />
    </div>
  </ScreenTools.Provider></TooltipProvider>;
}

function UpdaterGate({ status }: { status?: StartupStatus }) {
  const [retrying, setRetrying] = useState(false);
  const failed = status?.phase === "failed";
  return <main className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center" aria-live={failed ? "assertive" : "polite"}>
    <img src={`${import.meta.env.BASE_URL}assets/logo.svg`} alt="" width="56" height="56" />
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

const themeModes: { mode: ThemeMode; label: string; icon: ReactNode }[] = [
  { mode: "system", label: "System", icon: <Monitor /> },
  { mode: "light", label: "Light", icon: <Sun /> },
  { mode: "dark", label: "Dark", icon: <Moon /> },
];

/** Theme, window snap, and mini mode, at the right end of every page header. `icons` sit just before them, and `extra` before that, past a separator. */
function HeaderTools({ themeMode, patchSettings, openMini, icons, extra }: Pick<ScreenProps, "patchSettings" | "openMini"> & { themeMode?: ThemeMode; icons?: ReactNode; extra?: ReactNode }) {
  const themeIndex = Math.max(0, themeModes.findIndex(({ mode }) => mode === themeMode));
  const theme = themeModes[themeIndex];
  const nextTheme = themeModes[(themeIndex + 1) % themeModes.length];
  return <div className="flex shrink-0 items-center">
    {extra && <>{extra}<span className="mx-1 h-4 w-px bg-border" aria-hidden="true" /></>}
    {icons}
    <IconButton label={`Theme: ${theme.label}`} className="text-muted-foreground" onClick={() => void patchSettings("themeMode", nextTheme.mode)}>{theme.icon}</IconButton>
    {!isDemo() && <IconButton label="Resize to default aspect ratio" className="text-muted-foreground" onClick={() => void bridge.snapWindow()}><Proportions /></IconButton>}
    {!isDemo() && <IconButton label="Open mini mode" className="text-muted-foreground" onClick={openMini}><Minimize2 /></IconButton>}
  </div>;
}

function Sidebar({ route, ...props }: ScreenProps & { route: AppRoute }) {
  const { state, navigate, refresh, notify } = props;
  const actions = useWidgetActions(props, async (_id, action, message) => {
    try { await action(); await refresh(); }
    catch (error) { notify(failure(`${message} Does retrying help?`, error)); }
  });
  const [saved, setWidth] = useState(readSidebarWidth);
  const [dragging, setDragging] = useState(false);
  const [viewport, setViewport] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  /** The saved width, narrowed so the content keeps at least 560 pixels. */
  const width = saved === SIDEBAR_COLLAPSED ? saved : Math.min(saved, Math.max(SIDEBAR_MIN, viewport - 560));
  const collapsed = width === SIDEBAR_COLLAPSED;
  const right = state.settings.sidebarPosition === "right";
  const persist = (next: number) => { setWidth(next); try { localStorage.setItem(sidebarWidthKey, String(next)); } catch { /* The width falls back to the default. */ } };
  useEffect(() => {
    if (!dragging) return;
    const { style } = document.body;
    style.cursor = "col-resize"; style.userSelect = "none";
    return () => { style.cursor = ""; style.userSelect = ""; };
  }, [dragging]);
  const current = route === "/accounts/places" ? "/accounts" : route.startsWith("/settings/") || route.endsWith("/settings") ? "/settings" : route;
  const item = (target: AppRoute, label: string, icon: ReactNode, enabled = true) => <Tooltip key={target}>
    <TooltipTrigger render={<button className={cn(
      "flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0",
      current === target && "bg-sidebar-accent font-medium text-foreground hover:bg-sidebar-accent",
    )} aria-current={current === target ? "page" : undefined} aria-disabled={!enabled || undefined} onClick={() => { if (enabled) navigate(target); }} aria-label={label} />}>
      {icon}{!collapsed && <span className="truncate">{label}</span>}
    </TooltipTrigger>
    <TooltipContent side={right ? "left" : "right"} className={cn(!collapsed && "hidden")}>{enabled ? label : `${label} is disabled`}</TooltipContent>
  </Tooltip>;
  return <aside data-slot="sidebar" style={{ width }} className={cn("relative flex shrink-0 flex-col gap-1 bg-sidebar p-2", !dragging && "transition-[width] duration-150", right ? "border-l border-sidebar-border" : "border-r border-sidebar-border")} aria-label="Main navigation">
    <Tooltip>
      <TooltipTrigger render={<button className="mb-2 flex h-10 items-center gap-2 overflow-hidden rounded-lg px-1.5 outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50" onClick={() => void bridge.openExternal("https://toolblox.dev")} aria-label="Toolblox website" />}>
        <img src={`${import.meta.env.BASE_URL}assets/logo.svg`} alt="" width="24" height="24" className="shrink-0" />
        {!collapsed && <span className="truncate font-semibold tracking-tight">Toolblox</span>}
      </TooltipTrigger>
      <TooltipContent side={right ? "left" : "right"}>Website</TooltipContent>
    </Tooltip>
    <nav className="flex flex-1 flex-col gap-0.5 overflow-hidden">
      {coreRoutes.map(({ route: target, label, icon: Icon }) => item(target, label, <Icon aria-hidden="true" />))}
      {state.installedWidgets.length > 0 && (collapsed ? <hr className="my-2 border-sidebar-border" /> : <p className="mt-4 mb-1 truncate px-2.5 text-xs text-muted-foreground">Widgets</p>)}
      {state.installedWidgets.map((widget) => <WidgetContextMenu key={widget.id} actions={actions(widget)}>
        {item(`/widgets/${widget.id}`, widget.name, widget.logoUrl ? <img src={widget.logoUrl} alt="" className="size-4 shrink-0 rounded-sm object-cover" /> : <Puzzle aria-hidden="true" />, widget.enabled && !state.safeMode)}
      </WidgetContextMenu>)}
    </nav>
    {!collapsed && <LoopingRow className="px-0.5">{() => <span className="shrink-0 px-2 py-1 text-xs whitespace-nowrap text-muted-foreground" title={state.channel === "canary" ? "Running from a source checkout." : "The installed, publicly released build."}>v{state.version}{state.channel === "canary" ? "-canary" : ""}</span>}</LoopingRow>}
    <WidgetSlot name="sidebar.footer" props={{ collapsed }} />
    <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuemin={SIDEBAR_COLLAPSED} aria-valuemax={SIDEBAR_MAX} aria-valuenow={width} aria-valuetext={collapsed ? "Icon only" : `${width} pixels`} tabIndex={0}
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

/**
 * A row that scrolls sideways without an end once it's wider than its container. Three copies sit
 * side by side, and whenever the position leaves the middle copy it moves by one copy's width, so
 * the row wraps around. Only the middle copy is in the tab order and the accessibility tree.
 * Vertical wheel scrolling moves it sideways. A row that fits shows one copy and doesn't scroll.
 */
function LoopingRow({ className, children }: { className?: string; children: (clone: boolean) => ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const middle = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setFits((middle.current?.offsetWidth ?? 0) <= element.clientWidth));
    observer.observe(element);
    if (middle.current) observer.observe(middle.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || fits) return;
    const cycle = () => middle.current?.offsetWidth ?? 0;
    element.scrollLeft = cycle();
    const wrap = () => {
      const width = cycle();
      if (!width) return;
      if (element.scrollLeft < width / 2) element.scrollLeft += width;
      else if (element.scrollLeft > width * 1.5) element.scrollLeft -= width;
    };
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      element.scrollLeft += event.deltaY;
    };
    element.addEventListener("scroll", wrap);
    element.addEventListener("wheel", wheel, { passive: false });
    return () => { element.removeEventListener("scroll", wrap); element.removeEventListener("wheel", wheel); };
  }, [fits]);
  const copy = (clone: boolean, key: number) => <div key={key} ref={clone ? undefined : middle} aria-hidden={clone || undefined} className="flex shrink-0 items-center gap-1 pr-1">{children(clone)}</div>;
  return <div ref={scroller} className={cn("flex [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", fits ? "overflow-hidden" : "overflow-x-auto", className)}>
    {fits ? copy(false, 1) : [copy(true, 0), copy(false, 1), copy(true, 2)]}
  </div>;
}

/**
 * A widget's page, with its `page.topbar` entries and a link to its Settings tab in the header. A
 * widget in its own window shows where it went.
 */
function WidgetHost({ widget, state, navigate, notify }: ScreenProps & { widget: WidgetSummary }) {
  const { pages, slots } = useWidgetRegistry();
  const hasSettings = useWidgetHasSettings(state)(widget);
  const poppedOut = state.popouts.includes(widget.id);
  const Page = pages.get(widget.id);
  const topbar = slots.get("page.topbar")?.some((item) => item.widgetId === widget.id);
  const tools = (topbar || hasSettings) && <>
    {topbar && <WidgetSlot name="page.topbar" props={{}} widgetId={widget.id} />}
    {hasSettings && <IconButton label={`${widget.name} settings`} className="text-muted-foreground" onClick={() => navigate(`/widgets/${widget.id}/settings`)}><SettingsIcon /></IconButton>}
  </>;
  const show = () => void bridge.openWidgetPopout(widget.id).catch((error) => notify(failure("The window couldn't be shown. Does retrying help?", error)));
  const back = () => void bridge.closeWidgetPopout(widget.id).catch((error) => notify(failure("The window didn't close. Does retrying help?", error)));
  if (poppedOut) return <Screen title={widget.name} className="h-full" iconTools={hasSettings && tools}>
    <EmptyState icon={<PictureInPicture2 />} title={`${widget.name} is in its own window`} action={<div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={show}>Show window</Button>
      <Button variant="ghost" size="sm" onClick={back}><AppWindow />Return here</Button>
    </div>} />
  </Screen>;
  return <WidgetPageContext.Provider value={{ widgetId: widget.id, popout: false }}>
    <Screen title={widget.name} className="h-full" iconTools={tools}>
      {Page ? <WidgetBoundary widgetId={widget.id}><Page /></WidgetBoundary>
        : widget.hasPageFrame ? <WidgetFrame widget={widget} surface="main" title={widget.name} />
        : <EmptyState icon={<Puzzle />} title="No widget page" />}
    </Screen>
  </WidgetPageContext.Provider>;
}

function NotFound({ navigate }: { navigate: (route: AppRoute) => void }) {
  return <EmptyState icon={<ExternalLink />} title="Page unavailable" action={<Button onClick={() => navigate("/")}>Go to Dashboard</Button>} />;
}

function PlaceDialog({ request, recentPlaces, open, close, forget }: { request: PlaceRequest; recentPlaces: RecentPlace[]; open: boolean; close: () => void; forget: (placeId: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setValue(""); setError(""); setBusy(false); } }, [open]);
  const save = async (placeId: string) => { setBusy(true); await request.run(placeId); close(); };
  const submit = async () => {
    const placeId = parsePlaceId(value);
    if (!placeId) { setError("No place ID found. Is it a game from the list, a Roblox game link, or a place ID?"); return; }
    setBusy(true);
    const exists = await bridge.placeExists(placeId).catch(() => true);
    setBusy(false);
    if (exists) void save(placeId);
    else setError(`Place ${placeId} doesn't exist. Is the ID correct?`);
  };
  return <Modal size="portrait" open={open} close={close} title={request.title} description={request.description} action={request.action} busy={busy} disabled={!value.trim()} submit={() => void submit()}>
    <div className="grid gap-2">
      <div className="relative">
        <PlaceInput autoFocus value={value} change={(next) => { setValue(next); setError(""); }} placeholder="Game name, link, or place ID"
          aria-label="Game name, Roblox game link, or place ID" aria-invalid={!!error} aria-describedby={error ? "place-dialog-error" : undefined} />
      </div>
      {error && <p id="place-dialog-error" className="text-xs text-destructive">{error}</p>}
    </div>
    {recentPlaces.length > 0 && <section className="grid gap-1" aria-labelledby="place-dialog-recent">
      <h3 id="place-dialog-recent" className="text-xs text-muted-foreground">Recent places</h3>
      <ul className="-mx-2 grid">
        {recentPlaces.map((place) => <li key={place.placeId} className="flex items-center rounded-lg pr-1 hover:bg-muted">
          <button type="button" disabled={busy} className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" onClick={() => void save(place.placeId)}>
            <span className="min-w-0 flex-1 truncate" title={place.name}>{place.name || "Unknown game"}</span>
            <span className="font-mono text-xs text-muted-foreground">{place.placeId}</span>
          </button>
          <IconButton type="button" label={`Remove ${place.name || place.placeId} from recent places`} size="icon-xs" disabled={busy} onClick={() => void forget(place.placeId)}><X /></IconButton>
        </li>)}
      </ul>
    </section>}
  </Modal>;
}

function ConfirmDialog({ request, open, close, notify }: { request: ConfirmRequest; open: boolean; close: () => void; notify: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setBusy(false); }, [open]);
  const submit = async () => { setBusy(true); try { await request.run(); close(); } catch (error) { notify(failure(`The action failed. Does retrying help?`, error)); setBusy(false); } };
  return <Modal size="landscape" scale={request.scale} open={open} close={close} title={request.title} description={request.message} action={request.action} danger={request.danger} busy={busy} submit={() => void submit()} />;
}

/** A widget's page and settings in its own window. Only that widget's module runs here. */
export function PopoutApp({ widgetId }: { widgetId: string }) {
  const [state, setState] = useState<AppState>();
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<"page" | "settings">("page");
  const toasts = useToasts();
  const notify = toasts.notify;
  useTheme(state?.settings.themeMode);
  useMotion(state?.settings.showAnimations ?? true, state?.settings.ignoreReducedMotion ?? false);
  useCustomTheme(!!state, !state?.safeMode, notify);
  const { pages, settingsPages, slots } = useWidgetRegistry();
  const load = async () => {
    try { setState(await bridge.getAppState()); setLoadError(""); }
    catch (error) { setLoadError(`The widget failed to load. Does reopening its window help? (${String(error)})`); }
  };
  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const stopListening = bridge.onWidgetsChanged(() => void load());
    return () => { window.removeEventListener("focus", onFocus); stopListening(); };
  }, []);
  const widget = state?.installedWidgets.find(({ id }) => id === widgetId);
  const moduleKey = state ? JSON.stringify([state.safeMode, widget?.enabled, widget?.moduleUrl]) : "";
  useEffect(() => { if (state) void syncWidgetModules(widget ? [widget] : [], state.safeMode); }, [moduleKey]);
  useEffect(() => {
    if (state) syncWidgetHost(state, {
      navigate: () => undefined,
      notify,
      refresh: load,
      join: (accountIds) => void bridge.joinAccounts(accountIds).then(load).catch((error) => notify(failure("Join failed. Is Roblox installed and the account signed in?", error))),
    });
  });
  if (!state || !widget) return <main className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground" aria-live="polite">
    {loadError ? <p className="max-w-sm text-destructive">{loadError}</p> : <><Spinner className="size-5" />Loading…</>}
  </main>;

  const Page = pages.get(widget.id);
  const hasSettings = widget.hasSettings || settingsPages.has(widget.id);
  const settings = view === "settings" && hasSettings;
  const tools = <>
    {!settings && slots.get("page.topbar")?.some((item) => item.widgetId === widget.id) && <WidgetSlot name="page.topbar" props={{}} widgetId={widget.id} />}
    {hasSettings && (settings
      ? <IconButton label={`Back to ${widget.name}`} className="text-muted-foreground" onClick={() => setView("page")}><ArrowLeft /></IconButton>
      : <IconButton label={`${widget.name} settings`} className="text-muted-foreground" onClick={() => setView("settings")}><SettingsIcon /></IconButton>)}
  </>;
  return <TooltipProvider delay={400}><ScreenTools.Provider value={(pageTools, iconTools) => <>{pageTools}{iconTools}</>}>
    <WidgetPageContext.Provider value={{ widgetId: widget.id, popout: true }}>
      <main className="h-full" id="main-content">
        <Screen title={settings ? `${widget.name} settings` : widget.name} className="h-full px-4" iconTools={tools}>
          {settings ? <WidgetSettingsTab widget={widget} state={state} notify={notify} popout />
            : Page ? <WidgetBoundary widgetId={widget.id}><Page /></WidgetBoundary>
            : <EmptyState icon={<Puzzle />} title="No widget page" />}
        </Screen>
      </main>
    </WidgetPageContext.Provider>
    <Toaster {...toasts} side="right" />
  </ScreenTools.Provider></TooltipProvider>;
}

export default App;
