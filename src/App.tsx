import { AppWindow, ArrowLeft, ExternalLink, LayoutDashboard, Minimize2, Monitor, Moon, PictureInPicture2, Proportions, Puzzle, Settings as SettingsIcon, ShieldAlert, Sun, Users } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./index.css";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster, parseToast, useToasts, type ToastAction, type ToastKind } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { bridge, copyFailureReport, isDemo } from "@/bridge";
import { ErrorBoundary, PageError } from "@/ErrorBoundary";
import { pageOf, useCustomTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { SIDEBAR_COLLAPSED, accountName, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampSidebarWidth, opaqueSquare, stepSidebarWidth } from "@/logic";
import { Accounts } from "@/screens/Accounts";
import { Dashboard } from "@/screens/Dashboard";
import { MiniWindow } from "@/screens/Mini";
import { ChangelogScreen, showChangelogAfterUpdate } from "@/screens/Changelog";
import { GroupEditor } from "@/screens/Groups";
import { PlaceSearch } from "@/screens/PlaceSearch";
import { CustomCssScreen } from "@/screens/Themes";
import { LogScreen, SettingsScreen, WidgetSettingsTab } from "@/screens/Settings";
import { WidgetContextMenu, useWidgetActions, useWidgetHasSettings } from "@/screens/WidgetMenu";
import { Widgets } from "@/screens/Widgets";
import { DISCORD_URL, DiscordIcon, EmptyState, IconButton, Modal, Screen, ScreenTools, Spinner, WidgetFrame, type ConfirmRequest, type NextJoin, type ScreenProps, failure } from "@/shared";
import { WidgetBoundary, WidgetPageContext, WidgetSlot, syncWidgetHost, syncWidgetModules, useWidgetRegistry, type CoreScreen } from "@/widgets/host";
import type { AppRoute, AppState, Settings, StartupStatus, ThemeMode, WidgetSummary } from "@/types";

const coreRoutes = [
  { route: "/" as const, label: "Dashboard", icon: LayoutDashboard },
  { route: "/accounts" as const, label: "Accounts", icon: Users },
  { route: "/widgets" as const, label: "Widgets", icon: Puzzle },
  { route: "/settings" as const, label: "Settings", icon: SettingsIcon },
];

const routeFromHash = (): AppRoute => {
  const value = window.location.hash.slice(1) || "/";
  return value === "/" || value === "/accounts" || value === "/accounts/places" || value === "/accounts/players" || value === "/accounts/group" || value === "/widgets" || value === "/settings" || value === "/settings/css" || value === "/settings/log" || value === "/settings/changelog" || value.startsWith("/widgets/")
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

/** Whether the first theme has been applied. Later changes are revealed as a circle from `themeOrigin`, the last click. */
let themed = false;
const themeOrigin = { x: window.innerWidth, y: 0 };
window.addEventListener("pointerdown", (event) => { themeOrigin.x = event.clientX; themeOrigin.y = event.clientY; }, { capture: true, passive: true });

/** Applies the `dark` class from the saved mode, following the OS while the mode is "system". A
 * change after the first is revealed as a circle from the last click, unless motion is off or reduced. */
function useTheme(mode: ThemeMode = "system") {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const root = document.documentElement;
      const dark = mode === "dark" || (mode === "system" && (siteDark ?? media.matches));
      const first = !themed;
      themed = true;
      if (dark === root.classList.contains("dark")) return;
      if (first || root.dataset.motion || !document.startViewTransition) { root.classList.toggle("dark", dark); return; }
      const { x, y } = themeOrigin;
      const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      void document.startViewTransition(() => { root.classList.toggle("dark", dark); }).ready.then(() => root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 560, easing: "cubic-bezier(0.22, 1, 0.36, 1)", pseudoElement: "::view-transition-new(root)" },
      )).catch(() => undefined);
    };
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
  const notify = useCallback((message: string, kind?: ToastKind, action?: ToastAction) => {
    if (!miniRef.current) { toasts.notify(message, kind, action); return; }
    const { title, description } = parseToast(message, kind);
    void bridge.showNotification(title, description).catch(() => undefined);
  }, [toasts.notify]);
  const setMiniMode = (open: boolean) => {
    miniRef.current = open;
    setMini(open);
    if (!open) void bridge.setMiniWindow(null).catch((error) => notify(failure(`The window wasn't restored. Does retrying help?`, error)));
  };
  /** The last pointer press in the window, where a page reveal starts. */
  const lastPointer = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  useEffect(() => {
    const press = (event: PointerEvent) => { lastPointer.current = { x: event.clientX, y: event.clientY }; };
    window.addEventListener("pointerdown", press, true);
    return () => window.removeEventListener("pointerdown", press, true);
  }, []);
  const [joining, setJoining] = useState<number[]>([]);
  /** One-time destinations, kept in memory. Each is dropped once a join that used it launches. */
  const [nextJoin, setNextJoinState] = useState<Record<string, NextJoin>>({});
  /** The account being joined and the total, while several join in turn. */
  const [joinProgress, setJoinProgress] = useState<{ done: number; total: number }>();
  useEffect(() => bridge.onJoinProgress(setJoinProgress), []);
  /** Accounts whose join was cancelled during the current launch. */
  const cancelledJoins = useRef(new Set<number>());
  const [confirm, setConfirm] = useState<ConfirmRequest>();
  const [confirmOpen, setConfirmOpen] = useState(false);
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
        if (status.phase !== "ready") return;
        await load();
        if (!cancelled && await bridge.takeUpdated().catch(() => false)) { showChangelogAfterUpdate(); navigate("/settings/changelog"); }
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

  /** Where the last click landed, relative to the page area, for the reveal into or out of a page. */
  const revealFrom = useRef({ x: 0, y: 0 });
  const navigate = (next: AppRoute) => {
    const page = document.getElementById("main-content")?.getBoundingClientRect();
    if (page) revealFrom.current = { x: lastPointer.current.x - page.left, y: lastPointer.current.y - page.top };
    window.location.hash = next;
    setRoute(next);
  };
  /** The games and players search pages share one page, so switching between them doesn't remount. */
  const pageKey = route === "/accounts/players" ? "/accounts/places" : route;
  /** Search slides in from the right and Accounts slides back from the left. Other pages rise. */
  const [pages, setPages] = useState({ from: pageKey, to: pageKey });
  if (pages.to !== pageKey) setPages({ from: pages.to, to: pageKey });
  /** Pages outside the sidebar reveal as a circle from the last click, going in and coming back. */
  const offSidebar = (page: string) => page === "/accounts/places" || page.startsWith("/settings/");
  const revealing = pages.from !== pageKey && (offSidebar(pages.from) || offSidebar(pageKey));
  /** Grows the new page as a circle from the last click to its farthest corner. Runs before the
   * first paint, with pixel values WebKit can animate. Skipped while motion is off or reduced. */
  useLayoutEffect(() => {
    const main = document.getElementById("main-content");
    if (!revealing || !main || document.documentElement.dataset.motion) return;
    const { x, y } = revealFrom.current;
    const radius = Math.hypot(Math.max(x, main.clientWidth - x), Math.max(y, main.clientHeight - y));
    const circle = (size: number) => `circle(${size}px at ${x}px ${y}px)`;
    const animation = main.animate([
      { clipPath: circle(0), webkitClipPath: circle(0), opacity: 0.6 },
      { clipPath: circle(radius), webkitClipPath: circle(radius), opacity: 1 },
    ], { duration: 520, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    return () => animation.cancel();
  }, [pageKey]);
  if (!startup || startup.phase !== "ready") return <UpdaterGate status={startup} />;
  if (!state) return <main className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground" aria-live="polite">
    {loadError ? <><p className="max-w-sm text-destructive">{loadError}</p><Button variant="outline" onClick={() => void load()}>Retry</Button></> : <LoadingSkeleton label="Loading Toolblox" />}
  </main>;

  const done = (message: string) => { if (!state.settings.reduceToasts) notify(message); };
  const patchSettings = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const settings = { ...state.settings, [key]: value };
    setState((current) => current ? { ...current, settings } : current);
    try { await bridge.saveSettings(settings); }
    catch (error) { notify(failure(`The setting wasn't saved. Does retrying help?`, error)); void load(); }
  };
  const setNextJoin = (key: number | "default", value?: NextJoin) => setNextJoinState(({ [String(key)]: _, ...rest }) => value ? { ...rest, [String(key)]: value } : rest);
  /** Launches the accounts and resolves to those that weren't cancelled, or none when the join failed. */
  const launch = async (accountIds: number[], placeId?: string): Promise<number[]> => {
    setJoining(accountIds);
    accountIds.forEach((id) => cancelledJoins.current.delete(id));
    try {
      await bridge.joinAccounts(accountIds, placeId);
      const launched = accountIds.filter((id) => !cancelledJoins.current.has(id));
      const only = launched.length === 1 ? state.accounts.find(({ id }) => id === launched[0]) : undefined;
      if (!miniRef.current && launched.length) done(only ? `Joining as ${accountName(only)}.` : `Joining with ${launched.length} accounts.`);
      await load();
      return launched;
    }
    catch (error) { notify(failure(`Join failed. Is Roblox installed and the account signed in?`, error)); await load(); return []; }
    finally { setJoining([]); setJoinProgress(undefined); }
  };
  /** An account's one-time destination: its own, or the default one when it has no saved place. */
  const nextJoinFor = (id: number) => nextJoin[id] ?? (state.accounts.find((account) => account.id === id)?.placeId ? undefined : nextJoin.default);
  const join = (accountIds: number[], placeId?: string) => {
    if (placeId) { void launch(accountIds, placeId); return; }
    const needsPlace = !state.settings.placeId && accountIds.some((id) => !nextJoinFor(id) && !state.accounts.find((account) => account.id === id)?.placeId);
    if (needsPlace) {
      if (miniRef.current) { notify("Joining requires a default place. Is one set on the Accounts page?"); return; }
      navigate("/accounts/places");
      return;
    }
    const groups = new Map<string | undefined, number[]>();
    for (const id of accountIds) { const target = nextJoinFor(id)?.target; groups.set(target, [...groups.get(target) ?? [], id]); }
    void (async () => {
      for (const [target, ids] of groups) {
        const launched = await launch(ids, target);
        if (target === undefined || !launched.length) continue;
        setNextJoinState((current) => {
          const next = { ...current };
          for (const id of launched) if (next[id]?.target === target) delete next[id];
          if (next.default?.target === target && launched.some((id) => !current[id])) delete next.default;
          return next;
        });
      }
    })();
  };
  const signIn = async (accountId: number) => {
    try { const account = await bridge.beginRobloxLogin(accountId); done(`Signed in again as ${accountName(account)}.`); await load(); }
    catch (error) { notify(failure(`Sign-in didn't complete. Was the sign-in window closed?`, error)); }
  };
  /** Cancels the joins in progress for `accountIds`. Accounts already in Roblox stay in game. */
  const cancelJoin = (accountIds: number[]) => {
    const cancelled = accountIds.filter((id) => joining.includes(id));
    if (!cancelled.length) return;
    cancelled.forEach((id) => cancelledJoins.current.add(id));
    setJoining((current) => current.filter((id) => !cancelled.includes(id)));
    void bridge.cancelJoin(cancelled).then(() => done(cancelled.length === 1 ? "Join cancelled." : `${cancelled.length} joins cancelled.`))
      .catch((error) => notify(failure(`The join wasn't cancelled. Does retrying help?`, error)));
  };
  const props: ScreenProps = { state, refresh: load, navigate, notify, done, confirm: (request) => { setConfirm(request); setConfirmOpen(true); }, join, joining, joinProgress, cancelJoin, nextJoin, setNextJoin, signIn, patchSettings, openMini: () => setMiniMode(true) };
  host.current = [state, { navigate, notify, refresh: load, join }];
  if (mini) return <TooltipProvider delay={400}><MiniWindow state={state} join={join} joining={joining} cancelJoin={cancelJoin} signIn={signIn} notify={notify} exit={() => setMiniMode(false)} /></TooltipProvider>;

  const replaced = (name: CoreScreen) => {
    const entry = registry.screens.get(name);
    return entry && <WidgetBoundary widgetId={entry.widgetId}><entry.value /></WidgetBoundary>;
  };
  let screen: ReactNode;
  if (route === "/") screen = replaced("dashboard") || <Dashboard {...props} />;
  else if (route === "/accounts") screen = replaced("accounts") || <Accounts {...props} />;
  else if (route === "/accounts/places") screen = <PlaceSearch {...props} kind="games" />;
  else if (route === "/accounts/players") screen = <PlaceSearch {...props} kind="players" />;
  else if (route === "/accounts/group") screen = <GroupEditor {...props} />;
  else if (route === "/widgets") screen = replaced("widgets") || <Widgets {...props} />;
  else if (route === "/settings") screen = <SettingsScreen {...props} themes={themes} />;
  else if (route === "/settings/css") screen = <CustomCssScreen {...props} themes={themes} />;
  else if (route === "/settings/log") screen = <LogScreen {...props} />;
  else if (route === "/settings/changelog") screen = <ChangelogScreen {...props} />;
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
        <main key={pageKey} data-page={pageOf(route)} className={cn("min-h-0 flex-1", !revealing && "animate-in duration-300 ease-enter fade-in-0 slide-in-from-bottom-3 motion-reduce:animate-none")} id="main-content">
          <ErrorBoundary scope={`page ${route}`} resetKey={route} fallback={(error, reset) => <PageError error={error} reset={reset} home={() => navigate("/")} />}>{screen}</ErrorBoundary>
        </main>
        <span className="pointer-events-none absolute right-2 bottom-1 z-10 text-xs text-muted-foreground opacity-50 select-none">v{state.version}{state.channel === "canary" ? "-canary" : ""}</span>
      </div>
      {confirm && <ConfirmDialog request={confirm} open={confirmOpen} close={() => setConfirmOpen(false)} notify={notify} />}
      <Toaster {...toasts} side={state.settings.sidebarPosition === "right" ? "left" : "right"} copyLogs={copyLogs(notify)} />
    </div>
  </ScreenTools.Provider></TooltipProvider>;
}

/** Placeholder for the window's content while app state loads. */
function LoadingSkeleton({ label }: { label: string }) {
  return <div className="grid w-full max-w-sm gap-3" role="status" aria-label={label}>
    <Skeleton className="h-16 rounded-xl" />
    <Skeleton className="h-10 rounded-xl" />
    <Skeleton className="h-10 rounded-xl" />
  </div>;
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
    </div> : <Skeleton className="h-1.5 w-40 rounded-full" role="status" aria-label={status?.phase === "installing" ? "Installing" : "Checking"} />}
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

const trimmedLogos = new Map<string, Promise<string>>();

/** Crops an icon to its visible pixels, as a PNG data URL. Falls back to the original URL when
 * the image can't be read. */
const trimLogo = (url: string) => {
  let trimmed = trimmedLogos.get(url);
  if (!trimmed) {
    trimmed = new Promise<string>((resolve) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onerror = () => resolve(url);
      image.onload = () => {
        try {
          const width = image.naturalWidth || 64, height = image.naturalHeight || 64;
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          const context = canvas.getContext("2d");
          if (!context) return resolve(url);
          context.drawImage(image, 0, 0, width, height);
          const square = opaqueSquare(context.getImageData(0, 0, width, height).data, width, height);
          if (!square) return resolve(url);
          const [x, y, size] = square;
          const out = document.createElement("canvas");
          out.width = out.height = size;
          out.getContext("2d")?.drawImage(canvas, x, y, size, size, 0, 0, size, size);
          resolve(out.toDataURL());
        } catch { resolve(url); }
      };
      image.src = url;
    });
    trimmedLogos.set(url, trimmed);
  }
  return trimmed;
};

/** A widget's icon in the sidebar, cropped to its visible pixels so it fills the row's icon slot. */
function SidebarLogo({ url }: { url: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => { let live = true; void trimLogo(url).then((value) => { if (live) setSrc(value); }); return () => { live = false; }; }, [url]);
  return src ? <img src={src} alt="" className="size-4 shrink-0 rounded-sm object-contain" /> : <span className="size-4 shrink-0" aria-hidden="true" />;
}

function Sidebar({ route, ...props }: ScreenProps & { route: AppRoute }) {
  const { state, navigate, refresh, notify, done } = props;
  const actions = useWidgetActions(props, async (_id, action, message, success) => {
    try { await action(); if (success) done(success); await refresh(); }
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
  const current = route.startsWith("/accounts/") ? "/accounts" : route.startsWith("/settings/") || route.endsWith("/settings") ? "/settings" : route;
  const nav = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ top: number; height: number }>();
  /** Moves the current page's highlight to its row, which slides there. */
  useLayoutEffect(() => {
    const active = nav.current?.querySelector<HTMLElement>("[aria-current=page]");
    const next = active ? { top: active.offsetTop, height: active.offsetHeight } : undefined;
    if (next?.top !== pill?.top || next?.height !== pill?.height) setPill(next);
  });
  const rowClass = "relative flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:transition-transform [&_svg]:duration-300 [&_svg]:ease-spring hover:[&_svg]:scale-115 active:[&_svg]:scale-90";
  const item = (target: AppRoute, label: string, icon: ReactNode, enabled = true) => <Tooltip key={target}>
    <TooltipTrigger render={<button className={cn(rowClass,
      current === target && "font-medium text-foreground hover:bg-transparent",
    )} aria-current={current === target ? "page" : undefined} aria-disabled={!enabled || undefined} onClick={() => { if (enabled) navigate(target); }} aria-label={label} />}>
      {icon}{!collapsed && <span className="animate-in truncate duration-300 ease-enter fade-in-0 slide-in-from-left-2">{label}</span>}
    </TooltipTrigger>
    <TooltipContent side={right ? "left" : "right"} className={cn(!collapsed && "hidden")}>{enabled ? label : `${label} is disabled`}</TooltipContent>
  </Tooltip>;
  return <aside data-slot="sidebar" style={{ width }} className={cn("relative flex shrink-0 flex-col gap-1 bg-sidebar p-2", !dragging && "transition-[width] duration-150", right ? "border-l border-sidebar-border" : "border-r border-sidebar-border")} aria-label="Main navigation">
    <Tooltip>
      <TooltipTrigger render={<button className="group/logo mb-2 flex h-10 items-center gap-2 overflow-hidden rounded-lg px-1.5 outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50" onClick={() => void bridge.openExternal("https://toolblox.dev")} aria-label="Toolblox website" />}>
        <img src={`${import.meta.env.BASE_URL}assets/logo.svg`} alt="" width="24" height="24" className="shrink-0 transition-transform duration-500 ease-spring group-hover/logo:rotate-[-12deg] group-hover/logo:scale-110" />
        {!collapsed && <span className="animate-in truncate font-semibold tracking-tight duration-300 ease-enter fade-in-0 slide-in-from-left-2">Toolblox</span>}
      </TooltipTrigger>
      <TooltipContent side={right ? "left" : "right"}>Website</TooltipContent>
    </Tooltip>
    <nav ref={nav} className="relative flex flex-1 flex-col gap-0.5 overflow-hidden">
      {pill && <span className="pointer-events-none absolute inset-x-0 top-0 rounded-lg bg-sidebar-accent transition-[translate,height] duration-500 ease-spring" style={{ translate: `0 ${pill.top}px`, height: pill.height }} aria-hidden="true" />}
      {coreRoutes.map(({ route: target, label, icon: Icon }) => item(target, label, <Icon aria-hidden="true" />))}
      {state.installedWidgets.length > 0 && (collapsed ? <hr className="my-2 border-sidebar-border" /> : <p className="mt-4 mb-1 truncate px-2.5 text-xs text-muted-foreground">Widgets</p>)}
      {state.installedWidgets.map((widget) => <WidgetContextMenu key={widget.id} actions={actions(widget)}>
        {item(`/widgets/${widget.id}`, widget.name, widget.logoUrl ? <SidebarLogo url={widget.logoUrl} /> : <Puzzle aria-hidden="true" />, widget.enabled && !state.safeMode)}
      </WidgetContextMenu>)}
    </nav>
    <WidgetSlot name="sidebar.footer" props={{ collapsed }} />
    <hr className="border-sidebar-border" />
    <Tooltip>
      <TooltipTrigger render={<button className={rowClass} onClick={() => void bridge.openExternal(DISCORD_URL)} aria-label="Discord server" />}>
        <span className="flex shrink-0 text-discord"><DiscordIcon /></span>
        {!collapsed && <><span className="truncate">Discord</span><ExternalLink className="ml-auto size-3.5 opacity-60" aria-hidden="true" /></>}
      </TooltipTrigger>
      <TooltipContent side={right ? "left" : "right"} className={cn(!collapsed && "hidden")}>Discord server</TooltipContent>
    </Tooltip>
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

function ConfirmDialog({ request, open, close, notify }: { request: ConfirmRequest; open: boolean; close: () => void; notify: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setBusy(false); }, [open]);
  const submit = async () => { setBusy(true); try { await request.run(); close(); } catch (error) { notify(failure(`The action failed. Does retrying help?`, error)); setBusy(false); } };
  return <Modal size="landscape" scale={request.scale} open={open} close={close} title={request.title} description={request.message} action={request.action} danger={request.danger} busy={busy} submit={() => void submit()} />;
}

/** Copies an error toast's message with the recent log, and confirms with a toast. */
const copyLogs = (notify: (message: string) => void) => (message: string) =>
  void copyFailureReport(message).then(() => notify("Logs copied."), (error) => notify(failure("The logs weren't copied. Does retrying help?", error)));

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
    {loadError ? <p className="max-w-sm text-destructive">{loadError}</p> : <LoadingSkeleton label="Loading" />}
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
    <Toaster {...toasts} side="right" copyLogs={copyLogs(notify)} />
  </ScreenTools.Provider></TooltipProvider>;
}

export default App;
