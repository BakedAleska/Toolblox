import { ArrowLeftRight, Hammer, MapPin, UserRound } from "lucide-react";
import { createContext, useContext, useEffect, useId, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { bridge } from "@/bridge";
import { accountName, parseJoinTarget, targetUserId } from "@/logic";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { ToastKind } from "@/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Account, AppRoute, AppState, PlaceMatch, PlayerMatch, Settings, WidgetSummary } from "@/types";


/** A join target's name when Toolblox knows it: the game name, or `@` and a player's username. */
export const targetName = (state: AppState, target: string) => {
  const name = state.recentPlaces.find((place) => place.placeId === target)?.name;
  return name && targetUserId(target) !== undefined ? `@${name}` : name;
};

/** A join target's name when Toolblox knows it, otherwise its place ID or `Player <id>`. */
export const placeLabel = (state: AppState, target: string) => targetName(state, target) || (targetUserId(target) !== undefined ? `Player ${target.slice(1)}` : target);

/** What a target field holds: a game's place, or a player. */
export type TargetKind = "place" | "player";

/** The symbol at the start of a target or search field, shown as a small button with a swap
 * arrow. Selecting it switches between games and players. It keeps focus in the field. Fields
 * that hold it need `pl-14`. */
export function TargetKindToggle({ kind, toggle, gameIcon = <MapPin />, className }: { kind: TargetKind; toggle: () => void; gameIcon?: ReactNode; className?: string }) {
  return <IconButton type="button" label={kind === "player" ? "Players. Switch to games" : "Games. Switch to players"} variant="secondary" size="xs"
    className={cn("absolute inset-y-0 left-1 z-10 my-auto gap-0.5 overflow-hidden px-1.5 text-secondary-foreground", className)} onPointerDown={(event) => event.preventDefault()} onClick={toggle}>
    <span key={kind} className="flex animate-in duration-200 ease-out fade-in-0 slide-in-from-bottom-3 motion-reduce:animate-none">{kind === "player" ? <UserRound /> : gameIcon}</span>
    <ArrowLeftRight className={cn("size-3 opacity-60 transition-transform duration-300 ease-out motion-reduce:transition-none", kind === "player" && "rotate-180")} />
  </IconButton>;
}


/** An error message for a toast. Errors that already end with a recovery question, as the
 * backend's do, are shown alone; others follow `message` in parentheses. */
export const failure = (message: string, error: unknown) => {
  const text = String(error).replace(/^Error: /, "").trim();
  return text.endsWith("?") ? text : `${message} (${text})`;
};

/** A destination for the next manual join only. `name` labels it, since it isn't in the recent list. */
export type NextJoin = { target: string; name: string };

export type ConfirmRequest = { title: string; message: string; action: string; danger?: boolean; scale?: ModalScale; run: () => Promise<void> };

/** Shared callbacks every screen receives from the app shell. */
export type ScreenProps = {
  state: AppState;
  refresh: () => Promise<void>;
  navigate: (route: AppRoute) => void;
  notify: (message: string, kind?: ToastKind) => void;
  /** Confirms a finished action with a toast, unless **Reduce toasts** is on. */
  done: (message: string) => void;
  confirm: (request: ConfirmRequest) => void;
  /** Launches the accounts, first asking for a place when one of them has none. */
  join: (accountIds: number[], placeId?: string) => void;
  /** Accounts whose join is in progress. */
  joining: number[];
  /** The account being joined and the total, while several join in turn. */
  joinProgress?: { done: number; total: number };
  /** Cancels the joins in progress for these accounts. */
  cancelJoin: (accountIds: number[]) => void;
  /** One-time destinations by account ID, or `default` for accounts without their own. */
  nextJoin: Record<string, NextJoin>;
  /** Sets or clears a one-time destination for an account, or for `default`. */
  setNextJoin: (key: number | "default", value?: NextJoin) => void;
  /** Opens the Roblox sign-in for an account whose session expired. */
  signIn: (accountId: number) => Promise<void>;
  patchSettings: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
  /** Shrinks the window into the mini window. */
  openMini: () => void;
};

const permissionLabels: Record<string, string> = {
  "accounts.read.basic": "read account names and avatars",
  "widgetData.read": "read its own account data",
  "widgetData.write": "write its own account data",
  "roblox.status": "read account presence",
  "roblox.join": "join games with accounts",
  "network.fetch": "contact approved websites",
  "process.spawn": "run native code as the current user",
};

export const permissionSummary = (permissions: string[]) => permissions.map((permission) => permissionLabels[permission] || permission).join(", ");

/**
 * Renders the app-wide buttons at the right end of every page header. A page's own `tools` are
 * grouped before them, past a separator, and its `iconTools` sit beside them in the same group.
 */
export const ScreenTools = createContext<(tools?: ReactNode, iconTools?: ReactNode) => ReactNode>(() => null);

/** Scrolling page with a sticky header. The column is a container, so pages switch to more columns
 * with `@5xl:` and wider queries as the window grows, and caps at 120rem on very wide screens. The
 * header keeps a gap below it so scrolled content doesn't meet its edge. */
export function Screen({ title, actions, tools: pageTools, iconTools, toolbar, children, className }: { title: string; actions?: ReactNode; tools?: ReactNode; iconTools?: ReactNode; toolbar?: ReactNode; children: ReactNode; className?: string }) {
  const tools = useContext(ScreenTools)(pageTools, iconTools);
  return <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
    <div data-slot="screen" className={cn("@container mx-auto flex min-h-full max-w-[120rem] flex-col gap-2 px-6 pb-6", className)}>
      <header data-slot="screen-header" className="sticky top-0 z-10 -mx-6 shrink-0 bg-background/90 px-6 pb-2 backdrop-blur-sm">
        <div className="flex h-14 items-center gap-2">
          <h1 className="mr-auto shrink-0 animate-in pr-2 text-lg font-semibold tracking-tight duration-500 ease-enter fade-in-0 slide-in-from-left-3">{title}</h1>
          {actions}
          {actions && tools && <span className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />}
          {tools}
        </div>
        {toolbar && <div className="mt-2 flex flex-wrap items-center gap-2">{toolbar}</div>}
      </header>
      {children}
    </div>
  </div>;
}

export function Panel({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="panel" className={cn("rounded-xl bg-card ring-1 ring-foreground/8", className)} {...props} />;
}

/** A titled section of related settings. */
export function Group({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="flex flex-col gap-2"><SectionTitle action={action}>{title}</SectionTitle>{children}</section>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="flex min-h-8 items-center justify-between gap-2"><h2 className="text-sm font-medium text-muted-foreground">{children}</h2>{action}</div>;
}

export function IconButton({ label, children, variant = "ghost", size = "icon", ...props }: { label: string } & ComponentProps<typeof Button>) {
  return <Tooltip>
    <TooltipTrigger render={<Button variant={variant} size={size} aria-label={label} {...props} />}>{children}</TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>;
}

/** Shows `label` in a tooltip while `children` is hovered or focused. */
export function Hint({ label, side, children }: { label: ReactNode; side?: ComponentProps<typeof TooltipContent>["side"]; children: ReactElement }) {
  return <Tooltip>
    <TooltipTrigger render={children} />
    <TooltipContent side={side}>{label}</TooltipContent>
  </Tooltip>;
}

export const DISCORD_URL = "https://discord.gg/VkFad5fGB6";

/** The Discord mark. Lucide has no brand icons, so it's drawn here. */
export const DiscordIcon = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.32 4.37a19.8 19.8 0 0 0-4.93-1.51 13.78 13.78 0 0 0-.64 1.28 18.27 18.27 0 0 0-5.5 0 12.64 12.64 0 0 0-.64-1.28h-.05A19.74 19.74 0 0 0 3.64 4.4 20.26 20.26 0 0 0 .11 18.09l.02.02a19.9 19.9 0 0 0 6.04 3.03l.04-.02a14.24 14.24 0 0 0 1.23-2.03.08.08 0 0 0-.05-.07 13.1 13.1 0 0 1-1.9-.92.08.08 0 0 1 .02-.1 10.2 10.2 0 0 0 .41-.31h.04a14.2 14.2 0 0 0 12.1 0l.04.01a9.63 9.63 0 0 0 .4.32.08.08 0 0 1-.03.1 12.29 12.29 0 0 1-1.9.91.08.08 0 0 0-.02.1 15.97 15.97 0 0 0 1.27 2.01h.04a19.84 19.84 0 0 0 6.03-3.05v-.03a20.12 20.12 0 0 0-3.57-13.69ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.22 0 2.18 1.1 2.16 2.42 0 1.34-.94 2.42-2.16 2.42Z" /></svg>;

/** Opens the Toolblox Discord server in the browser. */
export function DiscordButton({ size }: { size?: ComponentProps<typeof Button>["size"] }) {
  return <IconButton label="Discord server" size={size} className="text-muted-foreground" onClick={() => void bridge.openExternal(DISCORD_URL)}>
    <DiscordIcon />
  </IconButton>;
}

/** Dialog shapes. Landscape holds one-sentence confirmations: one wide, short shape with the
 * buttons beside the text, as tall as the text. Forms and lists are pages instead. Portrait remains
 * for widgets that use it, in two scales. */
const modalSizes = {
  portrait: { default: "h-96 max-w-96", small: "h-80 max-w-80 p-4" },
  landscape: { default: "max-w-lg p-4", small: "max-w-lg p-4" },
};
export type ModalScale = "default" | "small";

/** Every dialog in the app: a title, an optional description, content, and Cancel beside one
 * action. It's a form, so Enter runs the action. It can't be closed while `busy`. */
export function Modal({ open, close, title, description, action, submit, busy = false, disabled = false, danger = false, size, scale = "default", children }: {
  open: boolean;
  close: () => void;
  title: ReactNode;
  description?: ReactNode;
  action: string;
  submit: () => void;
  busy?: boolean;
  disabled?: boolean;
  danger?: boolean;
  size: keyof typeof modalSizes;
  scale?: ModalScale;
  children?: ReactNode;
}) {
  const landscape = size === "landscape";
  const header = <AlertDialogHeader>
    <AlertDialogTitle>{title}</AlertDialogTitle>
    {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
  </AlertDialogHeader>;
  const footer = <AlertDialogFooter className={landscape ? "shrink-0 pt-0" : "mt-auto"}>
    <AlertDialogCancel type="button" size={landscape ? "sm" : "default"} disabled={busy}>Cancel</AlertDialogCancel>
    <Button type="submit" size={landscape ? "sm" : "default"} variant={danger ? "destructive" : "default"} disabled={busy || disabled}>{busy && <Spinner />}{action}</Button>
  </AlertDialogFooter>;
  return <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) close(); }}>
    <AlertDialogContent className={cn("flex flex-col", modalSizes[size][scale])}>
      <form className={landscape ? "flex flex-wrap items-end gap-x-4 gap-y-3" : "contents"} onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {landscape ? <div className="grid min-w-0 flex-1 basis-56 gap-3">{header}{children}</div> : <>{header}{children}</>}
        {footer}
      </form>
    </AlertDialogContent>
  </AlertDialog>;
}

/** Runs `search` for `query` 300 ms after it stops changing, or returns no matches while `query`
 * is undefined. */
function useSearch<T>(query: string | undefined, search: (query: string) => Promise<T[]>) {
  const [matches, setMatches] = useState<T[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (query === undefined) { setMatches([]); setSearching(false); return; }
    let current = true;
    setSearching(true);
    const timer = window.setTimeout(() => void search(query)
      .then((found) => { if (current) setMatches(found); })
      .catch(() => { if (current) setMatches([]); })
      .finally(() => { if (current) setSearching(false); }), 300);
    return () => { current = false; window.clearTimeout(timer); };
  }, [query]);
  return { matches, searching };
}

/** Searches Roblox games for text that isn't a place ID, link, or `@` player. */
export function usePlaceSearch(text: string) {
  const query = text.trim();
  return useSearch<PlaceMatch>(query.length < 2 || query.startsWith("@") || parseJoinTarget(query) ? undefined : query, bridge.searchPlaces);
}

/** Searches Roblox players for text that isn't a user ID or profile link. A leading `@` is
 * ignored. */
export function usePlayerSearch(text: string) {
  const query = text.trim().replace(/^@/, "").trim();
  return useSearch<PlayerMatch>(query.length < 2 || parseJoinTarget(text) ? undefined : query, bridge.searchPlayers);
}

/** Spinning ring that takes an icon's place while an action runs. */
export function Spinner({ className }: { className?: string }) {
  return <span className={cn("inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent opacity-60", className)} aria-hidden="true" />;
}

export function Avatar({ account, className, status = true }: { account: Account; className?: string; status?: boolean }) {
  return <span className={cn("relative inline-grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground", className)} aria-hidden="true">
    {account.avatarUrl ? <img className="size-full rounded-full object-cover" src={account.avatarUrl} alt="" /> : <UserRound className="size-1/2" />}
    {status && (account.presence !== "offline" || account.sessionExpired) && <PresenceMark account={account} className="absolute right-0 bottom-0 ring-2 ring-card" />}
  </span>;
}

/** An account's display name, truncated to fit. */
export function AccountName({ account, className }: { account: Account; className?: string }) {
  return <span data-slot="account-name" title={accountName(account)} className={cn("inline-flex max-w-full min-w-0", className)}>
    <span className="truncate">{accountName(account)}</span>
  </span>;
}

/** One account as a card: avatar, name, and the surface's own details and actions. */
export function AccountCard({ account, showAvatar, avatarClassName, nameClassName, leading, eyebrow, inline, children, actions, className, ...props }: {
  account: Account;
  showAvatar: boolean;
  avatarClassName?: string;
  nameClassName?: string;
  /** Controls before the avatar, such as a drag handle or checkbox. */
  leading?: ReactNode;
  /** A short line above the name. */
  eyebrow?: ReactNode;
  /** Badges beside the name. */
  inline?: ReactNode;
  /** Details below the name. */
  children?: ReactNode;
  actions?: ReactNode;
} & Omit<ComponentProps<"div">, "children">) {
  return <Panel className={cn("flex items-center gap-3 p-3", className)} {...props}>
    {leading}
    {showAvatar && <Avatar account={account} className={avatarClassName} />}
    <div className="min-w-0 flex-1">
      {eyebrow}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <AccountName account={account} className={cn("text-sm font-medium", nameClassName)} />
        {inline}
      </div>
      {children}
    </div>
    {actions}
  </Panel>;
}

export const presenceLabel = (account: Account) => {
  if (account.sessionExpired) return "Session expired";
  if (account.presence === "warning") return "Status unavailable";
  if (account.presence !== "playing") return "";
  if (account.inStudio) return account.gameName || "Studio";
  return account.gameName ? `In game: ${account.gameName}` : "In game";
};

/** A short status for a badge: the game name moves to its tooltip, which `presenceLabel` gives. */
export const presenceShort = (account: Account) =>
  account.presence === "playing" && !account.sessionExpired ? (account.inStudio ? "In Studio" : "In game") : presenceLabel(account);

/** The status color shared by the avatar dot and the status badge. It always sits beside a text label. */
export const presenceTone = (account: Account) => account.sessionExpired ? "bg-destructive" : account.presence === "playing" ? account.inStudio ? "bg-warning" : "bg-success" : "bg-warning";

/** The status mark beside an account: a dot, or a hammer while the account is in Roblox Studio. */
export function PresenceMark({ account, className, small = false }: { account: Account; className?: string; small?: boolean }) {
  const studio = account.presence === "playing" && account.inStudio && !account.sessionExpired;
  return studio
    ? <span className={cn("grid shrink-0 place-items-center rounded-full text-background", presenceTone(account), small ? "size-3" : "size-3.5", className)} aria-hidden="true"><Hammer className={small ? "size-2" : "size-2.5"} strokeWidth={2.5} /></span>
    : <span className={cn("relative shrink-0 rounded-full", presenceTone(account), small ? "size-1.5" : "size-2.5", account.presence === "playing" && !account.sessionExpired && "after:absolute after:inset-0 after:animate-presence after:rounded-full after:bg-inherit", className)} aria-hidden="true" />;
}

export function SettingRow({ title, description, control }: { title: string; description?: string; control: (labelId: string, descriptionId?: string) => ReactNode }) {
  const id = useId();
  return <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
    <div className="min-w-0 flex-1 basis-40">
      <p id={`${id}-t`} className="text-sm font-medium">{title}</p>
      {description && <p id={`${id}-d`} className="text-xs text-muted-foreground">{description}</p>}
    </div>
    {control(`${id}-t`, description ? `${id}-d` : undefined)}
  </div>;
}

export function SwitchRow({ title, description, checked, disabled, change }: { title: string; description?: string; checked: boolean; disabled?: boolean; change: (value: boolean) => void }) {
  return <SettingRow title={title} description={description} control={(labelId, descriptionId) => <Switch checked={checked} disabled={disabled} onCheckedChange={(value) => change(value)} aria-labelledby={labelId} aria-describedby={descriptionId} />} />;
}

export function ChoiceRow<T extends string>({ title, description, value, options, change }: { title: string; description?: string; value: T; options: { value: T; label: string }[]; change: (value: T) => void }) {
  return <SettingRow title={title} description={description} control={(labelId) => <ToggleGroup variant="outline" size="sm" value={[value]} onValueChange={(values) => { if (values[0]) change(values[0] as T); }} aria-labelledby={labelId}>
    {options.map((option) => <ToggleGroupItem key={option.value} value={option.value} className="px-3">{option.label}</ToggleGroupItem>)}
  </ToggleGroup>} />;
}

/** A setting with a slider and its current value. */
export function SliderRow({ title, description, value, min, max, step = 1, unit = "", change }: { title: string; description?: string; value: number; min: number; max: number; step?: number; unit?: string; change: (value: number) => void }) {
  return <SettingRow title={title} description={description} control={(labelId, descriptionId) => <div className="flex w-40 items-center gap-2">
    <input type="range" min={min} max={max} step={step} value={value} aria-labelledby={labelId} aria-describedby={descriptionId} aria-valuetext={`${value}${unit}`} onChange={(event) => change(Number(event.target.value))}
      className="h-5 min-w-0 flex-1 cursor-pointer accent-primary outline-none focus-visible:ring-2 focus-visible:ring-ring" />
    <span className="w-10 text-right font-mono text-sm tabular-nums" aria-hidden="true">{value}{unit}</span>
  </div>} />;
}

export function StatTile({ icon, label, value, onClick }: { icon: ReactNode; label: string; value: ReactNode; onClick?: () => void }) {
  const body = <>
    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground @max-[10rem]:hidden [&_svg]:size-4" aria-hidden="true">{icon}</span>
    <span className="min-w-0">
      <span className="block text-xl leading-tight font-semibold tabular-nums">{value}</span>
      <span className="line-clamp-2 block text-xs text-muted-foreground">{label}</span>
    </span>
  </>;
  const className = "@container flex items-center gap-3 rounded-xl bg-card p-4 text-left ring-1 ring-foreground/8";
  return onClick
    ? <button onClick={onClick} className={cn(className, "outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring")}>{body}</button>
    : <div className={className}>{body}</div>;
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
    <span className="grid size-12 animate-in place-items-center rounded-full bg-muted text-muted-foreground duration-500 ease-spring zoom-in-50 fade-in-0 [&_svg]:size-5 [&_svg]:animate-float">{icon}</span>
    <div className="space-y-1"><h2 className="text-sm font-medium">{title}</h2>{text && <p className="max-w-xs text-sm text-muted-foreground">{text}</p>}</div>
    {action}
  </div>;
}

export function WidgetFrame({ widget, surface, title }: { widget: WidgetSummary; surface: "main" | "settings" | "dashboard"; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [session, setSession] = useState<{ sessionId: string; url: string }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let opened: { sessionId: string; url: string } | undefined;
    void bridge.openWidget(widget.id, surface).then((value) => { if (active) { opened = value; setSession(value); } else void bridge.closeWidgetSession(value.sessionId); }).catch((reason) => setError(String(reason)));
    return () => { active = false; if (opened) void bridge.closeWidgetSession(opened.sessionId); };
  }, [surface, widget.id]);
  useEffect(() => {
    if (!session) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data || event.data.type !== "toolbloxRequest") return;
      void bridge.widgetRequest(session.sessionId, widget.id, event.data.request).then((response) => frame.current?.contentWindow?.postMessage({ type: "toolbloxResponse", response }, "*")).catch((reason) => frame.current?.contentWindow?.postMessage({ type: "toolbloxResponse", response: { protocol: 1, requestId: event.data.request?.requestId || "", error: String(reason) } }, "*"));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [session, widget.id]);
  const height = surface === "main" ? "min-h-0 flex-1" : surface === "settings" ? "min-h-64" : "min-h-44";
  if (error) return <p className="text-sm text-destructive">The widget failed to open. Does reinstalling it help? ({error})</p>;
  if (!session) return <Skeleton className={cn("w-full rounded-xl", height)} role="status" aria-label="Opening widget" />;
  return <iframe className={cn("w-full rounded-xl bg-card ring-1 ring-foreground/8", height)} ref={frame} title={title} src={session.url} sandbox="allow-scripts" />;
}
