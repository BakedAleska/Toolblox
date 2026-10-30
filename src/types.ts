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
  /** In Roblox Studio rather than a game. `presence` is still "playing". */
  inStudio?: boolean;
  /** The game name, or `Studio - <place>` in Roblox Studio. */
  gameName?: string;
  gamePlaceId?: number;
  placeId?: string;
  lastPlaceId?: string;
  /** Roblox no longer accepts the saved session, or none is stored. */
  sessionExpired?: boolean;
  /** Shown on the dashboard. */
  pinned?: boolean;
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
  alwaysAnimate: boolean;
}

/** A game found by name, with the place a join opens. */
export interface PlaceMatch {
  placeId: string;
  name: string;
  playerCount: number;
  upVotes: number;
  downVotes: number;
  iconUrl?: string;
  maturity?: string;
  creatorName?: string;
  creatorVerified: boolean;
  visits?: number;
  favorites?: number;
  /** RFC 3339 timestamp of the last update. */
  updated?: string;
  genre?: string;
  /** Robux needed to join. Absent for free games. */
  price?: number;
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

export type AppRoute = "/" | "/accounts" | "/accounts/places" | "/widgets" | "/settings" | "/settings/css" | `/widgets/${string}`;

export type StartupStatus =
  | { phase: "checking" }
  | { phase: "installing"; version: string }
  | { phase: "ready" }
  | { phase: "failed"; message: string };

/** A page as named by the `data-page` attribute custom CSS can target. */
export type ThemePage = "dashboard" | "accounts" | "widgets" | "settings";
