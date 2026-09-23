export type ThemeMode = "system" | "light" | "dark";
export type SortOrder = "last_played" | "alphabetical" | "manual";
export type Presence = "offline" | "playing" | "warning";

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
}

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
