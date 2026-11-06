import * as React from "react";
import { AppWindow, PictureInPicture2 } from "lucide-react";
import { Component, createContext, useContext, useSyncExternalStore, type ComponentProps, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ToastKind } from "@/components/ui/toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { bridge, describeError } from "@/bridge";
import { cn } from "@/lib/utils";
import { AccountCard, AccountName, Avatar, ChoiceRow, EmptyState, Group, IconButton, Modal, Panel, SectionTitle, SettingRow, SliderRow, Spinner, StatTile, SwitchRow } from "@/shared";
import { system } from "@/widgets/kit";
import type { Account, AppRoute, AppState, LogLevel, WidgetSummary } from "@/types";

const logLevels: LogLevel[] = ["debug", "info", "warn", "error"];

/** Core screens a widget can replace. Toolblox Settings can't be replaced. */
export type CoreScreen = "dashboard" | "accounts" | "widgets";

/** Props each slot passes to its contributions. */
export type SlotProps = {
  "accounts.row": { account: Account };
  "accounts.toolbar": Record<string, never>;
  "dashboard.stats": Record<string, never>;
  "dashboard.sections": Record<string, never>;
  "sidebar.footer": { collapsed: boolean };
  /** The header of the widget's own page, in the main window and in its own window. */
  "page.topbar": Record<string, never>;
};
export type SlotName = keyof SlotProps;

type Owned<T> = { widgetId: string; value: T; order: number };
type HostActions = { navigate: (route: AppRoute) => void; notify: (message: string, kind?: ToastKind) => void; refresh: () => Promise<void>; join: (accountIds: number[]) => void };

const screens = new Map<CoreScreen, Owned<ComponentType>>();
const pages = new Map<string, ComponentType>();
const settingsPages = new Map<string, ComponentType>();
const slots = new Map<SlotName, Owned<ComponentType<never>>[]>();
const disposers = new Map<string, (() => void)[]>();
const loaded = new Map<string, { url?: string; sessionId?: string; deactivate?: () => void }>();
const errors = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
let appState: AppState | undefined;
let actions: HostActions | undefined;

const emit = () => { version += 1; listeners.forEach((listener) => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };

/** Re-renders when widgets add or remove contributions. */
export const useWidgetRegistry = () => {
  useSyncExternalStore(subscribe, () => version);
  return { screens, pages, settingsPages, slots, errors };
};

/** Keeps the host API's view of app state and actions current. Called by the app shell. */
export const syncWidgetHost = (state: AppState, next: HostActions) => {
  const changed = appState !== state;
  appState = state; actions = next;
  if (changed) emit();
};

const track = (widgetId: string, dispose: () => void) => {
  const list = disposers.get(widgetId) ?? [];
  list.push(dispose); disposers.set(widgetId, list);
  return () => { dispose(); disposers.set(widgetId, (disposers.get(widgetId) ?? []).filter((item) => item !== dispose)); emit(); };
};

/** The widget page being shown, and whether it's in the widget's own window. */
export const WidgetPageContext = createContext<{ widgetId: string; popout: boolean } | undefined>(undefined);

/**
 * Topbar entry that moves the widget's page into its own window, or back to the main window.
 * Renders nothing outside a widget page.
 */
function PopoutButton() {
  const page = useContext(WidgetPageContext);
  if (!page) return null;
  const move = () => (page.popout ? bridge.closeWidgetPopout(page.widgetId) : bridge.openWidgetPopout(page.widgetId))
    .catch((error) => actions?.notify(`The window didn't ${page.popout ? "close" : "open"}. Does retrying help? (${describeError(error)})`, "error"));
  return page.popout
    ? <IconButton label="Return to main window" className="text-muted-foreground" onClick={() => void move()}><AppWindow /></IconButton>
    : <IconButton label="Open in its own window" className="text-muted-foreground" onClick={() => void move()}><PictureInPicture2 /></IconButton>;
}

/** The app's dialog at the small scale unless the widget passes another. */
const WidgetModal = (props: ComponentProps<typeof Modal>) => <Modal scale="small" {...props} />;

/** Shared UI so widget interfaces match the rest of the app. */
const ui = {
  AccountCard, AccountName, Avatar, Badge, Button, Checkbox, ChoiceRow, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  EmptyState, Group, IconButton, Input, Modal: WidgetModal, Panel, PopoutButton, SectionTitle, SettingRow, SliderRow, Spinner, StatTile, Switch, SwitchRow, Tabs, TabsContent, TabsList, TabsTrigger,
  ToggleGroup, ToggleGroupItem, Tooltip, TooltipContent, TooltipTrigger, cn,
  /** The control-surface style for system widgets. See `src/widgets/kit.tsx`. `usePopout` reports whether the page is in the widget's own window. */
  system: { ...system, usePopout: () => useContext(WidgetPageContext)?.popout ?? false },
};

function createApi(widget: WidgetSummary, sessionId?: string) {
  const id = widget.id;
  const requireState = () => { if (!appState) throw new Error("Toolblox state isn't loaded yet."); return appState; };
  return {
    widget: { id, name: widget.name, version: widget.version },
    React,
    ui,
    getState: requireState,
    /** React hook that re-renders with the latest app state. */
    useAppState: () => { useSyncExternalStore(subscribe, () => version); return requireState(); },
    onStateChange: (listener: (state: AppState) => void) => track(id, subscribe(() => appState && listener(appState))),
    navigate: (route: AppRoute) => actions?.navigate(route),
    notify: (message: string, kind?: ToastKind) => actions?.notify(message, kind),
    refresh: () => actions?.refresh() ?? Promise.resolve(),
    join: (accountIds: number[]) => actions?.join(accountIds),
    replaceScreen: (screen: CoreScreen, component: ComponentType) => {
      screens.set(screen, { widgetId: id, value: component, order: 0 }); emit();
      return track(id, () => { if (screens.get(screen)?.widgetId === id) screens.delete(screen); });
    },
    registerPage: (component: ComponentType) => {
      pages.set(id, component); emit();
      return track(id, () => pages.delete(id));
    },
    registerSettings: (component: ComponentType) => {
      settingsPages.set(id, component); emit();
      return track(id, () => settingsPages.delete(id));
    },
    addToSlot: <S extends SlotName>(slot: S, component: ComponentType<SlotProps[S]>, options: { order?: number } = {}) => {
      const entry: Owned<ComponentType<never>> = { widgetId: id, value: component as ComponentType<never>, order: options.order ?? 0 };
      slots.set(slot, [...(slots.get(slot) ?? []), entry].sort((a, b) => a.order - b.order)); emit();
      return track(id, () => slots.set(slot, (slots.get(slot) ?? []).filter((item) => item !== entry)));
    },
    /** Adds a stylesheet to the whole app, for example to override theme tokens on `:root`. */
    addStyles: (css: string) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return track(id, () => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((item) => item !== sheet); });
    },
    /** Writes to the Toolblox log under this widget's ID. Secrets are redacted and lines over 8 KB are cut. */
    log: Object.fromEntries(logLevels.map((level) => [level, (message: string) => bridge.writeLog(level, message, id)])) as Record<LogLevel, (message: string) => Promise<void>>,
    storage: {
      get: () => bridge.getWidgetStore(id),
      set: (value: unknown) => bridge.setWidgetStore(id, value),
    },
    /** Sends a widget IPC request, such as `widgetData.set`, `network.fetch`, or `process.spawn`. */
    request: async (method: string, params: Record<string, unknown> = {}) => {
      if (!sessionId) throw new Error("The widget session isn't open.");
      const response = await bridge.widgetRequest(sessionId, id, { protocol: 1, requestId: crypto.randomUUID(), method, params }) as { result?: unknown; error?: string };
      if (response?.error) throw new Error(response.error);
      return response?.result;
    },
  };
}

export type ToolbloxApi = ReturnType<typeof createApi>;

function unload(widgetId: string) {
  const entry = loaded.get(widgetId);
  try { entry?.deactivate?.(); } catch (error) { void bridge.writeLog("error", `Deactivate failed: ${describeError(error)}`, widgetId); }
  (disposers.get(widgetId) ?? []).forEach((dispose) => dispose());
  disposers.delete(widgetId);
  if (entry?.sessionId) void bridge.closeWidgetSession(entry.sessionId);
  loaded.delete(widgetId);
  errors.delete(widgetId);
  emit();
}

/** Loads modules for enabled widgets, unloads ones that were disabled or removed, and reloads ones whose module URL changed. */
export async function syncWidgetModules(widgets: WidgetSummary[], safeMode: boolean) {
  const wanted = new Map(safeMode ? [] : widgets.filter((widget) => widget.enabled && widget.moduleUrl).map((widget) => [widget.id, widget]));
  for (const [id, entry] of [...loaded]) if (wanted.get(id)?.moduleUrl !== entry.url) unload(id);
  for (const widget of wanted.values()) {
    if (loaded.has(widget.id)) continue;
    loaded.set(widget.id, { url: widget.moduleUrl });
    try {
      const session = await bridge.openWidget(widget.id, "module").catch(() => undefined);
      const module = await import(/* @vite-ignore */ widget.moduleUrl!) as { activate?: (api: ToolbloxApi) => unknown; deactivate?: () => void };
      if (!loaded.has(widget.id)) continue;
      loaded.set(widget.id, { url: widget.moduleUrl, sessionId: session?.sessionId, deactivate: module.deactivate });
      await module.activate?.(createApi(widget, session?.sessionId));
    } catch (error) {
      void bridge.writeLog("error", `Module failed to load: ${describeError(error)}`, widget.id);
      errors.set(widget.id, String(error));
      emit();
    }
  }
}

/** Keeps a failing widget contribution from taking down the screen around it. */
export class WidgetBoundary extends Component<{ widgetId: string; children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) { return { error: String(error) }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { void bridge.writeLog("error", `Render failed: ${describeError(error)}${info.componentStack ?? ""}`, this.props.widgetId); }
  render() {
    if (!this.state.error) return this.props.children;
    const name = appState?.installedWidgets.find(({ id }) => id === this.props.widgetId)?.name ?? this.props.widgetId;
    return <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{name} failed to render. Does reinstalling it help? ({this.state.error})</p>;
  }
}

/** Renders every widget contribution for a slot, or only `widgetId`'s when it's set. */
export function WidgetSlot<S extends SlotName>({ name, props, widgetId, wrap }: { name: S; props: SlotProps[S]; widgetId?: string; wrap?: (children: ReactNode) => ReactNode }) {
  const { slots: current } = useWidgetRegistry();
  const items = (current.get(name) ?? []).filter((item) => !widgetId || item.widgetId === widgetId);
  if (!items.length) return null;
  const rendered = items.map(({ widgetId, value }, index) => {
    const Contribution = value as ComponentType<SlotProps[S]>;
    return <WidgetBoundary key={`${widgetId}-${index}`} widgetId={widgetId}><Contribution {...props} /></WidgetBoundary>;
  });
  return <>{wrap ? wrap(rendered) : rendered}</>;
}
