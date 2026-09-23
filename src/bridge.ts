import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Account, AppState, CatalogueEntry, Settings, StartupStatus, WidgetSummary } from "./types";

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;
const demoAccount = (id: number, name: string, displayName: string, extra: Partial<Account> = {}): Account =>
  ({ id, name, displayName, notes: "", addedAt: minutesAgo(60 * 24 * 30), presence: "offline", ...extra });
const demoWidget = (id: string, name: string, description: string, extra: Partial<WidgetSummary> = {}): WidgetSummary =>
  ({ id, name, description, enabled: true, version: "1.0.0", permissions: [], hasSettings: false, hasDashboardTile: false, hasPageFrame: true, canStartOnLaunch: false, startOnLaunch: false, hostUrl: "about:blank", ...extra });
const demoEntry = (id: string, name: string, description: string, version: string, permissions: string[] = []): CatalogueEntry =>
  ({ id, name, description, version, permissions });

/** Sample data for the browser build and `npm run demo`. It never touches real accounts or files. */
const demoState: AppState = {
  version: "0.2.0-beta",
  channel: "canary",
  platform: "windows",
  widgetsPath: "C:\\Users\\you\\AppData\\Roaming\\Toolblox\\widgets",
  accounts: [
    demoAccount(101, "builderman_alt", "Builder", { presence: "playing", gameName: "Pet Simulator 99", gamePlaceId: 8737899170, lastPlayedAt: minutesAgo(4), lastPlaceId: "8737899170", notes: "Main farming account" }),
    demoAccount(102, "crossroads_fan", "Crossroads Fan", { presence: "playing", gamePlaceId: 1818, lastPlayedAt: minutesAgo(38), lastPlaceId: "1818" }),
    demoAccount(103, "tradebot_03", "tradebot_03", { presence: "warning", lastPlayedAt: minutesAgo(60 * 5), notes: "Session may need a fresh sign-in" }),
    demoAccount(104, "weekend_player", "Weekend Player", { lastPlayedAt: minutesAgo(60 * 24 * 3), placeId: "606849621", lastPlaceId: "606849621" }),
    demoAccount(105, "new_account_2026", "Fresh Start"),
  ],
  installedWidgets: [
    demoWidget("rogue_lineage", "Rogue Lineage", "Tracks each account's race and class and shows them on the Accounts page.", { version: "0.3.0", permissions: ["accounts.read.basic"], hasPageFrame: false, moduleUrl: "/src/demo-widgets/rogue_lineage/main.js" }),
    demoWidget("trade-tracker", "Trade Tracker", "Logs trades per account and shows value changes over time.", { version: "1.2.0", permissions: ["accounts.read.basic", "widgetData.read", "widgetData.write"], hasSettings: true }),
    demoWidget("server-hopper", "Server Hopper", "Finds a fresh server and moves selected accounts there.", { version: "2.1.0", availableVersion: "2.2.0", permissions: ["accounts.read.basic", "roblox.status"], availablePermissions: ["accounts.read.basic", "roblox.status", "roblox.join"] }),
    demoWidget("afk-guard", "AFK Guard", "Keeps idle accounts from being kicked while you're away.", { enabled: false, version: "0.9.1", permissions: ["process.spawn"], canStartOnLaunch: true }),
    demoWidget("stock_notifier", "Stock Notifier", "Watches a game's shop and shows current stock on the dashboard.", { version: "1.0.4", permissions: ["network.fetch"], hasPageFrame: false, canStartOnLaunch: true, startOnLaunch: true, moduleUrl: "/src/demo-widgets/stock_notifier/main.js" }),
  ],
  widgetErrors: [],
  catalogue: [
    demoEntry("quest-planner", "Quest Planner", "Tracks daily quests across all your accounts in one checklist.", "1.3.0", ["accounts.read.basic", "widgetData.read", "widgetData.write"]),
    demoEntry("friend-finder", "Friend Finder", "Shows which of your accounts are in the same server as your friends.", "0.4.2", ["accounts.read.basic", "roblox.status"]),
    demoEntry("launch-scheduler", "Launch Scheduler", "Joins chosen accounts at set times, like before a daily event.", "1.0.0", ["accounts.read.basic", "roblox.join"]),
    demoEntry("fps-unlocker", "FPS Unlocker", "Raises the Roblox frame rate cap using a bundled helper.", "3.0.1", ["process.spawn"]),
    demoEntry("price-checker", "Price Checker", "Looks up item values from a community price list.", "2.5.0", ["network.fetch"]),
    demoEntry("session-notes", "Session Notes", "A scratchpad for each account that doesn't need any special access.", "1.1.0"),
  ],
  settings: {
    sidebarPosition: "left",
    themeMode: "system",
    showAvatars: true,
    compactMode: false,
    sortOrder: "last_played",
    placeId: "",
    multiInstance: false,
    autoRejoin: false,
    openOnLaunch: false,
    runInBackground: true,
    minimizeOnJoin: false,
    showGameNames: true,
    notifyOnDrop: false,
    alwaysOnTop: false,
  },
  safeMode: false,
  recentPlaces: [
    { placeId: "8737899170", name: "Pet Simulator 99" },
    { placeId: "606849621", name: "Jailbreak" },
    { placeId: "1818", name: "Classic: Crossroads" },
  ],
};

const demoStores = new Map<string, unknown>([
  ["rogue_lineage", { showIcons: true, accounts: { 101: { race: "lightborn", cls: "druid" }, 102: { race: "vind", cls: "shinobi" }, 104: { race: "gaian", cls: "necromancer" } } }],
]);

const rememberDemoPlace = (placeId: string) => {
  const existing = demoState.recentPlaces.find((place) => place.placeId === placeId);
  demoState.recentPlaces = [existing || { placeId }, ...demoState.recentPlaces.filter((place) => place.placeId !== placeId)].slice(0, 6);
};

const isTauri = () => "__TAURI_INTERNALS__" in window && import.meta.env.MODE !== "demo";
const copy = <T,>(value: T): T => structuredClone(value);

/** True when the app runs on sample data instead of the Rust host. */
export const isDemo = () => !isTauri();

export type UpdaterScenario = "update" | "failure";
const scenarioKey = "toolblox-demo-updater";

const readScenario = (): { scenario: UpdaterScenario; startedAt: number } | undefined => {
  try { return JSON.parse(sessionStorage.getItem(scenarioKey) || "null") || undefined; }
  catch { return undefined; }
};
const writeScenario = (scenario: UpdaterScenario) => {
  try { sessionStorage.setItem(scenarioKey, JSON.stringify({ scenario, startedAt: Date.now() })); }
  catch { /* Previews are optional. */ }
};

/** Replays the startup update screens with sample timing. Demo builds only. */
export const previewUpdater = (scenario: UpdaterScenario) => { writeScenario(scenario); window.location.reload(); };

const demoStartupStatus = (): StartupStatus => {
  const current = readScenario();
  if (!current) return { phase: "ready" };
  const elapsed = Date.now() - current.startedAt;
  if (elapsed < 2000) return { phase: "checking" };
  if (current.scenario === "failure") return { phase: "failed", message: "The update server couldn't be reached. Is the connection working?" };
  if (elapsed < 6000) return { phase: "installing", version: "0.2.0" };
  sessionStorage.removeItem(scenarioKey);
  return { phase: "ready" };
};

async function call<T>(command: string, args: Record<string, unknown>, demo: () => T): Promise<T> {
  return isTauri() ? invoke<T>(command, args) : copy(demo());
}

export const bridge = {
  startupStatus: () => call<StartupStatus>("startup_status", {}, demoStartupStatus),
  retryStartupUpdate: () => call<void>("retry_startup_update", {}, () => writeScenario("update")),
  quitStartup: () => call<void>("quit_startup", {}, () => { sessionStorage.removeItem(scenarioKey); window.location.reload(); }),
  getAppState: () => call<AppState>("get_app_state", {}, () => demoState),

  beginRobloxLogin: () =>
    call<Account>("begin_roblox_login", {}, () => {
      const account: Account = {
        id: Date.now(),
        name: `demo_user_${demoState.accounts.length + 1}`,
        displayName: `Demo User ${demoState.accounts.length + 1}`,
        notes: "",
        addedAt: Date.now(),
        presence: "offline",
      };
      demoState.accounts.push(account);
      return account;
    }),

  updateAccountNotes: (accountId: number, notes: string) =>
    call<void>("update_account_notes", { accountId, notes }, () => {
      const account = demoState.accounts.find(({ id }) => id === accountId);
      if (account) account.notes = notes;
    }),

  removeAccount: (accountId: number) =>
    call<void>("remove_account", { accountId }, () => {
      demoState.accounts = demoState.accounts.filter(({ id }) => id !== accountId);
    }),

  joinAccounts: (accountIds: number[], placeId?: string) =>
    call<void>("join_accounts", { accountIds, placeId: placeId ?? null }, () => {
      for (const account of demoState.accounts) {
        if (!accountIds.includes(account.id)) continue;
        account.lastPlayedAt = Date.now();
        account.lastPlaceId = placeId || account.placeId || demoState.settings.placeId || undefined;
      }
    }),

  reorderAccounts: (accountIds: number[]) =>
    call<void>("reorder_accounts", { accountIds }, () => {
      const positions = new Map(accountIds.map((id, index) => [id, index]));
      demoState.accounts.sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0));
    }),

  saveSettings: (settings: Settings) =>
    call<void>("save_settings", { settings }, () => {
      if (settings.placeId && settings.placeId !== demoState.settings.placeId) rememberDemoPlace(settings.placeId);
      demoState.settings = copy(settings);
    }),

  placeExists: (placeId: string) => call<boolean>("place_exists", { placeId }, () => true),

  setAccountPlace: (accountId: number, placeId: string | null) =>
    call<void>("set_account_place", { accountId, placeId }, () => {
      const account = demoState.accounts.find(({ id }) => id === accountId);
      if (account) account.placeId = placeId || undefined;
      if (placeId) rememberDemoPlace(placeId);
    }),

  installWidget: (entry: CatalogueEntry) =>
    call<void>("install_widget", { widgetId: entry.id }, () => {
      demoState.installedWidgets.push({
        ...entry,
        enabled: true,
        hasSettings: false,
        hasDashboardTile: false,
        hasPageFrame: true,
        canStartOnLaunch: false,
        startOnLaunch: false,
        hostUrl: "about:blank",
      });
      demoState.catalogue = demoState.catalogue.filter(({ id }) => id !== entry.id);
    }),

  setWidgetEnabled: (widgetId: string, enabled: boolean) =>
    call<void>("set_widget_enabled", { widgetId, enabled }, () => {
      const widget = demoState.installedWidgets.find(({ id }) => id === widgetId);
      if (widget) widget.enabled = enabled;
    }),

  setWidgetStartOnLaunch: (widgetId: string, enabled: boolean) =>
    call<void>("set_widget_start_on_launch", { widgetId, enabled }, () => {
      const widget = demoState.installedWidgets.find(({ id }) => id === widgetId);
      if (widget) widget.startOnLaunch = enabled;
    }),

  updateWidget: (widgetId: string) => call<void>("update_widget", { widgetId }, () => undefined),

  uninstallWidget: (widgetId: string) =>
    call<void>("uninstall_widget", { widgetId }, () => {
      demoState.installedWidgets = demoState.installedWidgets.filter(({ id }) => id !== widgetId);
    }),

  retryCatalogue: () => call<void>("retry_catalogue", {}, () => undefined),
  checkForUpdates: () => call<{ available: boolean; version?: string }>("check_for_updates", {}, () => ({ available: false })),
  openExternal: (url: string) => isTauri() ? openUrl(url) : Promise.resolve(window.open(url, "_blank", "noopener,noreferrer")).then(() => undefined),
  openWidget: (widgetId: string, surface: "main" | "settings" | "dashboard" | "module" = "main") => call<{ sessionId: string; url: string }>("open_widget", { widgetId, surface }, () => ({ sessionId: crypto.randomUUID(), url: "about:blank" })),
  getWidgetStore: (widgetId: string) => call<unknown>("get_widget_store", { widgetId }, () => demoStores.get(widgetId) ?? null),
  setWidgetStore: (widgetId: string, value: unknown) => call<void>("set_widget_store", { widgetId, value }, () => { demoStores.set(widgetId, copy(value)); }),
  restartApp: (safeMode: boolean) => call<void>("restart_app", { safeMode }, () => { demoState.safeMode = safeMode; window.location.reload(); }),
  closeWidgetSession: (sessionId: string) => call<void>("close_widget_session", { sessionId }, () => undefined),
  widgetRequest: (sessionId: string, widgetId: string, message: unknown) => call<unknown>("widget_request", { sessionId, widgetId, message: JSON.stringify(message) }, () => ({ protocol: 1, requestId: "demo", result: null })),
};
