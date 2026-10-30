import { Hammer, LoaderCircle, UserRound } from "lucide-react";
import { createContext, useContext, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { bridge } from "@/bridge";
import { accountName, parsePlaceId } from "@/logic";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ToastKind } from "@/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Account, AppRoute, AppState, PlaceMatch, Settings, WidgetSummary } from "@/types";

export type PlaceRequest = { title: string; description?: string; action: string; run: (placeId: string) => Promise<void> };

/** A place's game name when Toolblox knows it, otherwise its ID. */
export const placeLabel = (state: AppState, placeId: string) => state.recentPlaces.find((place) => place.placeId === placeId)?.name || placeId;


/** An error message for a toast. Errors that already end with a recovery question, as the
 * backend's do, are shown alone; others follow `message` in parentheses. */
export const failure = (message: string, error: unknown) => {
  const text = String(error).replace(/^Error: /, "").trim();
  return text.endsWith("?") ? text : `${message} (${text})`;
};

export type ConfirmRequest ={ title: string; message: string; action: string; danger?: boolean; run: () => Promise<void> };

/** Shared callbacks every screen receives from the app shell. */
export type ScreenProps = {
  state: AppState;
  refresh: () => Promise<void>;
  navigate: (route: AppRoute) => void;
  notify: (message: string, kind?: ToastKind) => void;
  confirm: (request: ConfirmRequest) => void;
  /** Launches the accounts, first asking for a place when one of them has none. */
  join: (accountIds: number[], placeId?: string) => void;
  /** Accounts whose join is in progress. */
  joining: number[];
  /** Opens the Roblox sign-in for an account whose session expired. */
  signIn: (accountId: number) => Promise<void>;
  askPlace: (request: PlaceRequest) => void;
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

/** Renders the app-wide buttons at the right end of every page header, with a page's own `tools` grouped before them. */
export const ScreenTools = createContext<(tools?: ReactNode) => ReactNode>(() => null);

/** Scrolling page with a sticky header. The column is a container, so pages switch to more columns
 * with `@5xl:` and wider queries as the window grows, and caps at 120rem on very wide screens. The
 * header keeps a gap below it so scrolled content doesn't meet its edge. */
export function Screen({ title, actions, tools: pageTools, toolbar, children, className }: { title: string; actions?: ReactNode; tools?: ReactNode; toolbar?: ReactNode; children: ReactNode; className?: string }) {
  const tools = useContext(ScreenTools)(pageTools);
  return <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
    <div className={cn("@container mx-auto flex min-h-full max-w-[120rem] flex-col gap-2 px-6 pb-6", className)}>
      <header data-slot="screen-header" className="sticky top-0 z-10 -mx-6 shrink-0 bg-background/90 px-6 pb-2 backdrop-blur-sm">
        <div className="flex h-14 items-center gap-2">
          <h1 className="mr-auto shrink-0 pr-2 text-lg font-semibold tracking-tight">{title}</h1>
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

/** The two dialog sizes. Portrait holds forms and lists, and landscape holds short messages. */
const modalSizes = { portrait: "h-96 max-w-96", landscape: "h-60 max-w-lg" };

/** Every dialog in the app: a title, an optional description, content, and Cancel beside one
 * action. It's a form, so Enter runs the action. It can't be closed while `busy`. */
export function Modal({ open, close, title, description, action, submit, busy = false, disabled = false, danger = false, size, children }: {
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
  children?: ReactNode;
}) {
  return <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) close(); }}>
    <AlertDialogContent className={cn("flex flex-col", modalSizes[size])}>
      <form className="contents" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter className="mt-auto">
          <AlertDialogCancel type="button" disabled={busy}>Cancel</AlertDialogCancel>
          <Button type="submit" variant={danger ? "destructive" : "default"} disabled={busy || disabled}>{busy && <Spinner />}{action}</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialogContent>
  </AlertDialog>;
}

/** Searches Roblox games for text that isn't a place ID or link, 300 ms after it stops changing. */
export function usePlaceSearch(text: string) {
  const [matches, setMatches] = useState<PlaceMatch[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const query = text.trim();
    if (query.length < 2 || parsePlaceId(query)) { setMatches([]); setSearching(false); return; }
    let current = true;
    setSearching(true);
    const timer = window.setTimeout(() => void bridge.searchPlaces(query)
      .then((found) => { if (current) setMatches(found); })
      .catch(() => { if (current) setMatches([]); })
      .finally(() => { if (current) setSearching(false); }), 300);
    return () => { current = false; window.clearTimeout(timer); };
  }, [text]);
  return { matches, searching };
}

/** A place field that also searches Roblox games by name. `placeName` labels the place after its ID.
 * `inset` sets the horizontal padding of the field and its label. The parent must be positioned. */
export function PlaceInput({ value, change, pick, placeName, inset = "px-2.5", className, onKeyDown, onFocus, onBlur, ...props }: {
  value: string;
  change: (value: string) => void;
  pick?: (place: PlaceMatch) => void;
  placeName?: string;
  inset?: string;
} & Omit<ComponentProps<"input">, "value" | "onChange" | "name">) {
  const id = useId();
  const found = usePlaceSearch(value).matches;
  const matches = found.slice(0, 6);
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [picked, setPicked] = useState<PlaceMatch>();
  useEffect(() => { setActive(-1); setDismissed(false); }, [found]);
  const open = focused && !dismissed && matches.length > 0;
  const choose = (place: PlaceMatch) => { setPicked(place); setDismissed(true); change(place.placeId); pick?.(place); };
  const label = picked && picked.placeId === value ? picked.name : placeName;
  return <>
    <Input {...props} name="place" value={value} autoComplete="off" spellCheck={false} role="combobox" aria-autocomplete="list" aria-expanded={open}
      aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
      className={cn("font-mono placeholder:font-sans", label && !focused && "text-transparent", inset, className)}
      onChange={(event) => change(event.target.value)}
      onFocus={(event) => { setFocused(true); onFocus?.(event); }}
      onBlur={(event) => { setFocused(false); onBlur?.(event); }}
      onKeyDown={(event) => {
        if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActive((index) => index < 0 ? (step > 0 ? 0 : matches.length - 1) : (index + step + matches.length) % matches.length);
        } else if (open && event.key === "Enter" && active >= 0) { event.preventDefault(); choose(matches[active]); }
        else if (open && event.key === "Escape") { event.preventDefault(); setDismissed(true); }
        else onKeyDown?.(event);
      }} />
    {label && <span className={cn("pointer-events-none absolute inset-0 flex items-center gap-2 overflow-hidden border border-transparent", inset)} aria-hidden="true">
      {focused ? <>
        <span className="invisible font-mono text-sm whitespace-pre">{value}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{label}</span>
      </> : <span className="min-w-0 truncate text-sm">{label}</span>}
    </span>}
    {open && <ul id={`${id}-list`} role="listbox" aria-label="Games" className="absolute top-full left-0 z-50 mt-1 grid w-full rounded-xl bg-popover p-1 text-popover-foreground shadow-lg shadow-shadow/10 ring-1 ring-foreground/10">
      {matches.map((place, index) => <li key={place.placeId} id={`${id}-${index}`} role="option" aria-selected={index === active}
        className={cn("flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm", index === active && "bg-accent text-accent-foreground")}
        onPointerDown={(event) => event.preventDefault()} onPointerEnter={() => setActive(index)} onClick={() => choose(place)}>
        <span className="min-w-0 flex-1 truncate">{place.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{place.placeId}</span>
      </li>)}
    </ul>}
  </>;
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn("animate-spin", className)} aria-hidden="true" />;
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

/** The status color shared by the avatar dot and the status badge. It always sits beside a text label. */
export const presenceTone = (account: Account) => account.sessionExpired ? "bg-destructive" : account.presence === "playing" ? account.inStudio ? "bg-warning" : "bg-success" : "bg-warning";

/** The status mark beside an account: a dot, or a hammer while the account is in Roblox Studio. */
export function PresenceMark({ account, className, small = false }: { account: Account; className?: string; small?: boolean }) {
  const studio = account.presence === "playing" && account.inStudio && !account.sessionExpired;
  return studio
    ? <span className={cn("grid shrink-0 place-items-center rounded-full text-background", presenceTone(account), small ? "size-3" : "size-3.5", className)} aria-hidden="true"><Hammer className={small ? "size-2" : "size-2.5"} strokeWidth={2.5} /></span>
    : <span className={cn("shrink-0 rounded-full", presenceTone(account), small ? "size-1.5" : "size-2.5", className)} aria-hidden="true" />;
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
    <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">{icon}</span>
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
  if (!session) return <div className={cn("grid place-items-center gap-2 text-sm text-muted-foreground", height)}><Spinner className="size-5" />Opening widget…</div>;
  return <iframe className={cn("w-full rounded-xl bg-card ring-1 ring-foreground/8", height)} ref={frame} title={title} src={session.url} sandbox="allow-scripts" />;
}
