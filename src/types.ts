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
  /** Notes shown while a game is the default destination, by place ID. */
  gameNotes?: Record<string, string>;
  addedAt: number;
  lastPlayedAt?: number;
  presence: Presence;
  /** In Roblox Studio rather than a game. `presence` is still "playing". */
  inStudio?: boolean;
  /** The game name, or `Studio - <place>` in Roblox Studio. */
  gameName?: string;
  gamePlaceId?: number;
  /** A place ID, or `@` and a user ID to follow a player. */
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
  bannerUrl?: string;
  enabled: boolean;
  version?: string;
  availableVersion?: string;
  permissions: string[];
  availablePermissions?: string[];
  /** Toolblox version the newer catalogue version needs, when this build is older. */
  availableNeedsApp?: string;
  hasSettings: boolean;
  hasDashboardTile: boolean;
  hasPageFrame: boolean;
  moduleUrl?: string;
  hostUrl: string;
}

export interface CatalogueEntry {
  id: string;
  name: string;
  description: string;
  icon?: string;
  logoUrl?: string;
  bannerUrl?: string;
  version: string;
  permissions: string[];
  /** Oldest Toolblox version the widget runs on. */
  minAppVersion?: string;
  /** Whether this build meets `minAppVersion`. */
  supported: boolean;
}

export interface Settings {
  sidebarPosition: "left" | "right";
  themeMode: ThemeMode;
  showAvatars: boolean;
  compactMode: boolean;
  sortOrder: SortOrder;
  /** A place ID, or `@` and a user ID to follow a player. */
  placeId: string;
  multiInstance: boolean;
  joinDelaySeconds: number;
  autoRejoin: boolean;
  openOnLaunch: boolean;
  runInBackground: boolean;
  minimizeOnJoin: boolean;
  notifyOnDrop: boolean;
  alwaysOnTop: boolean;
  showAnimations: boolean;
  ignoreReducedMotion: boolean;
  /** Hides toasts that confirm a finished action. */
  reduceToasts: boolean;
  /** Whose online friends the dashboard lists. */
  friendsSource: FriendsSource;
  /** Opens the Widgets page at installed widgets instead of scrolling to the catalogue. */
  widgetsOpenInstalled: boolean;
  /** Named sets of accounts that join together. */
  groups: AccountGroup[];
  /** Colored labels shown on accounts. */
  tags: AccountTag[];
}

export type TagColor = "gray" | "red" | "orange" | "yellow" | "green" | "blue";

/** A colored label on any number of accounts. `accountIds` may name removed accounts. */
export interface AccountTag {
  id: string;
  name: string;
  color: TagColor;
  /** Members while no game is the default destination. */
  accountIds: number[];
  /** Members while a game is the default destination, by place ID. */
  games?: Record<string, number[]>;
}

/** A named set of accounts that join together. Pinning it shows the group on the dashboard, not
 * its accounts. `accountIds` may name removed accounts, which are left out when shown. */
export interface AccountGroup {
  id: string;
  name: string;
  accountIds: number[];
  pinned: boolean;
  /** Where the group joins: a place ID, or `@` and a user ID. Unset, each account uses its own. */
  placeId?: string;
  notes: string;
}

export type FriendsSource = "all" | "pinned" | "last_played";

/** A friend who is online. */
export interface OnlineFriend {
  id: number;
  name: string;
  displayName: string;
  avatarUrl?: string;
  inGame: boolean;
  inStudio: boolean;
  /** The game name, or `Studio - <place>` in Roblox Studio. */
  gameName?: string;
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

/** A player found by name. */
export interface PlayerMatch {
  id: number;
  name: string;
  displayName: string;
  avatarUrl?: string;
  verified: boolean;
}

export type FriendStatus = "none" | "friends" | "requestSent" | "requestReceived";

/** An account's relationship with a player. Fields Roblox didn't answer are absent. */
export interface Relationship {
  friend: FriendStatus;
  following?: boolean;
  blocked?: boolean;
}

export type SocialAction = "requestFriend" | "acceptFriend" | "declineFriend" | "unfriend" | "follow" | "unfollow" | "block" | "unblock";

/** A recent join target. `placeId` is a place ID, or `@` and a user ID for a player, whose
 * `name` is their username. */
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
  /** IDs of widgets open in their own window. */
  popouts: string[];
}

export type AppRoute = "/" | "/accounts" | "/accounts/places" | "/accounts/players" | "/accounts/group" | "/widgets" | "/settings" | "/settings/css" | "/settings/log" | "/settings/changelog" | `/widgets/${string}`;

export type StartupStatus =
  | { phase: "checking" }
  | { phase: "installing"; version: string }
  | { phase: "ready" }
  | { phase: "failed"; message: string };

/** A page as named by the `data-page` attribute custom CSS can target. */
export type ThemePage = "dashboard" | "accounts" | "widgets" | "settings";
