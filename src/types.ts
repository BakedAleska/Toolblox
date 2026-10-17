export type ThemeMode = "system" | "light" | "dark";
export type SortOrder = "last_played" | "alphabetical" | "manual";
export type Presence = "offline" | "playing" | "warning";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Account {
  id: number;
  name: string;
  displayName: string;
  avatarUrl?: string;
  notes: string;
  addedAt: number;
  lastPlayedAt?: number;
  presence: Presence;
  gameName?: string;
  gamePlaceId?: number;
  placeId?: string;
  lastPlaceId?: string;
  /** Roblox no longer accepts the saved session, or none is stored. */
  sessionExpired?: boolean;
  /** Overrides the default client priority. */
  priority?: ClientPriority | null;
  /** Overrides the default client settings, for each value that's set. */
  clientSettings: ClientSettings;
  /** Added to the default FastFlags for this account's launches. */
  fastFlags: FastFlags;
}

export type FastFlags = Record<string, string | number | boolean>;

/** Values written before a launch. `null` leaves Roblox's value, or the default, unchanged. */
export interface ClientSettings {
  fpsCap?: number | null;
  /** `0` is automatic, `1` to `10` match Roblox's graphics slider. */
  graphicsQuality?: number | null;
  /** Windows only. */
  windowSize?: { width: number; height: number } | null;
}

export type ClientPriority = "normal" | "below_normal" | "low";
export type TileSize = "fit" | "medium" | "small";

export interface WidgetSummary {
  id: string;
  name: string;
  description: string;
  icon?: string;
  logoUrl?: string;
  enabled: boolean;
  version?: string;
  availableVersion?: string;
  permissions: string[];
  availablePermissions?: string[];
  hasSettings: boolean;
  hasDashboardTile: boolean;
  hasPageFrame: boolean;
  moduleUrl?: string;
  canStartOnLaunch: boolean;
  startOnLaunch: boolean;
  hostUrl: string;
}

export interface CatalogueEntry {
  id: string;
  name: string;
  description: string;
  icon?: string;
  logoUrl?: string;
  version: string;
  permissions: string[];
}

export interface Settings {
  sidebarPosition: "left" | "right";
  themeMode: ThemeMode;
  showAvatars: boolean;
  compactMode: boolean;
  sortOrder: SortOrder;
  placeId: string;
  multiInstance: boolean;
  autoRejoin: boolean;
  openOnLaunch: boolean;
  runInBackground: boolean;
  minimizeOnJoin: boolean;
  showGameNames: boolean;
  notifyOnDrop: boolean;
  alwaysOnTop: boolean;
  clientPriority: ClientPriority;
  /** Logical cores each client may use. `0` allows every core. Windows only. */
  cpuCores: number;
  tileSize: TileSize;
  fastFlagsEnabled: boolean;
  fastFlags: FastFlags;
  clientSettingsEnabled: boolean;
  clientSettings: ClientSettings;
}

export interface RecentPlace {
  placeId: string;
  name?: string;
}

export interface AppState {
  version: string;
  channel: "stable" | "canary";
  platform: "windows" | "macos";
  widgetsPath: string;
  /** Folder holding the log files, or empty when logging didn't start. */
  logsPath: string;
  accounts: Account[];
  installedWidgets: WidgetSummary[];
  widgetErrors: string[];
  catalogue: CatalogueEntry[];
  catalogueError?: string;
  settings: Settings;
  recentPlaces: RecentPlace[];
  safeMode: boolean;
}

export type AppRoute = "/" | "/accounts" | "/widgets" | "/settings" | `/widgets/${string}`;

export type StartupStatus =
  | { phase: "checking" }
  | { phase: "installing"; version: string }
  | { phase: "ready" }
  | { phase: "failed"; message: string };

/** A page as named by the `data-page` attribute custom CSS can target. */
export type ThemePage = "dashboard" | "accounts" | "widgets" | "settings";
