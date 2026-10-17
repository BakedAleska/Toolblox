import { Eye, HardDrive, LoaderCircle, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { bridge } from "@/bridge";
import { accountName } from "@/logic";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Account, AppRoute, AppState, ClientPriority, Settings, WidgetSummary } from "@/types";

/** The core commitments from `PRODUCT.md`, shown on the dashboard. */
export const commitments = (platform: AppState["platform"]) => [
  { icon: <Eye />, title: "Free and open source", text: "No ads or paid features. Every line of source code is public under the MIT License." },
  { icon: <ShieldCheck />, title: "No injection", text: "Never injects code into Roblox, reads or changes its memory, or provides exploits. Roblox opens through its own sign-in page and launcher." },
  { icon: <HardDrive />, title: "Data stays on this device", text: `Accounts and settings are stored on this device and sessions in ${platform === "macos" ? "the macOS login Keychain" : "Windows Credential Manager"}. There's no Toolblox server or telemetry.` },
];

/** The commitments as icons. Pressing one slides its title out beside it, and hovering an open
 * one shows its description. */
export function Commitments({ platform, className }: { platform: AppState["platform"]; className?: string }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (title: string) => setOpen((current) => { const next = new Set(current); if (next.has(title)) next.delete(title); else next.add(title); return next; });
  return <ul className={cn("flex flex-wrap items-center gap-1", className)}>
    {commitments(platform).map(({ icon, title, text }) => <li key={title}>
      <button type="button" aria-expanded={open.has(title)} aria-label={title} aria-description={text} title={open.has(title) ? text : title} onClick={() => toggle(title)}
        className="inline-flex h-7 items-center rounded-lg px-1.5 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:text-foreground [&_svg]:size-4 [&_svg]:shrink-0">
        {icon}
        <span className={cn("grid transition-[grid-template-columns,opacity] duration-200 ease-enter motion-reduce:transition-none", open.has(title) ? "grid-cols-[1fr] opacity-100" : "grid-cols-[0fr] opacity-0")} aria-hidden="true">
          <span className="overflow-hidden pl-1 text-xs whitespace-nowrap">{title}</span>
        </span>
      </button>
    </li>)}
  </ul>;
}

export type PlaceRequest = { title: string; description: string; action: string; run: (placeId: string) => Promise<void> };

/** A place's game name when Toolblox knows it, otherwise its ID. */
export const placeLabel = (state: AppState, placeId: string) => state.recentPlaces.find((place) => place.placeId === placeId)?.name || placeId;

export const priorityLabels: Record<ClientPriority, string> = { normal: "Normal", below_normal: "Below normal", low: "Low" };

export type ConfirmRequest = { title: string; message: string; action: string; danger?: boolean; run: () => Promise<void> };

/** Shared callbacks every screen receives from the app shell. */
export type ScreenProps = {
  state: AppState;
  refresh: () => Promise<void>;
  navigate: (route: AppRoute) => void;
  notify: (message: string) => void;
  confirm: (request: ConfirmRequest) => void;
  /** Launches the accounts, first asking for a place when one of them has none. */
  join: (accountIds: number[], placeId?: string) => void;
  /** Opens the Roblox sign-in for an account whose session expired. */
  signIn: (accountId: number) => Promise<void>;
  askPlace: (request: PlaceRequest) => void;
  patchSettings: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
};

const permissionLabels: Record<string, string> = {
  "accounts.read.basic": "read account names and avatars",
  "widgetData.read": "read its own account data",
  "widgetData.write": "write its own account data",
  "roblox.status": "read account presence",
  "roblox.join": "join games with your accounts",
  "network.fetch": "contact approved websites",
  "process.spawn": "run native code as your user",
};

export const permissionSummary = (permissions: string[]) => permissions.map((permission) => permissionLabels[permission] || permission).join(", ");

/** Scrolling page with a sticky header, width-capped so fullscreen stays readable. A toolbar sits
 * under the title, the same distance from it as content on pages without one. */
export function Screen({ title, actions, toolbar, children, className }: { title: string; actions?: ReactNode; toolbar?: ReactNode; children: ReactNode; className?: string }) {
  return <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
    <div className={cn("mx-auto flex min-h-full max-w-5xl flex-col gap-2 px-6 pb-6", className)}>
      <header data-slot="screen-header" className="sticky top-0 z-10 -mx-6 shrink-0 bg-background/90 px-6 backdrop-blur-sm">
        <div className="flex h-14 items-center gap-2">
          <h1 className="mr-auto shrink-0 pr-2 text-lg font-semibold tracking-tight">{title}</h1>
          {actions}
        </div>
        {toolbar && <div className="mt-2 flex items-center gap-2">{toolbar}</div>}
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

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn("animate-spin", className)} aria-hidden="true" />;
}

export function Avatar({ account, className }: { account: Account; className?: string }) {
  return <span className={cn("relative inline-grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground", className)} aria-hidden="true">
    {account.avatarUrl ? <img className="size-full rounded-full object-cover" src={account.avatarUrl} alt="" /> : <UserRound className="size-1/2" />}
    {account.presence !== "offline" && <span className={cn("absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-card", account.presence === "playing" ? "bg-success" : "bg-warning")} />}
  </span>;
}

/** An account's name that fades into its Roblox user ID while the name is hovered. After a short
 * pause one narrows out as the other widens in, so text beside the name keeps the same gap, and visibility follows the fade so only the text on screen can be
 * clicked or selected. The shown text stays put while the pointer is pressed on it or part of it is
 * selected. Pointer events only prompt a check: the swap follows `:hover`, because a pointer leave
 * during a text selection isn't always reported. Selecting the ID never includes its label. */
export function AccountName({ account, className }: { account: Account; className?: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [selected, setSelected] = useState(false);
  const [showId, setShowId] = useState(false);
  useEffect(() => {
    const update = () => { const selection = getSelection(); setSelected(!!selection && !selection.isCollapsed && !!root.current?.contains(selection.anchorNode)); };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);
  useEffect(() => {
    if (!pressed) return;
    const release = () => setPressed(false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => { window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); };
  }, [pressed]);
  useEffect(() => {
    if (pressed || selected) return;
    const timeout = window.setTimeout(() => {
      const over = root.current?.matches(":hover") ?? false;
      setHovered(over);
      setShowId(over);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [hovered, pressed, selected]);
  const fade = (shown: boolean) => cn("grid min-w-0 transition-[grid-template-columns,opacity,visibility] duration-300 ease-in-out motion-reduce:transition-none", shown ? "grid-cols-[1fr]" : "invisible grid-cols-[0fr] opacity-0");
  return <span ref={root} data-slot="account-name" className={cn("inline-flex max-w-full min-w-0", className)}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onPointerDown={() => setPressed(true)}>
    <span className={fade(!showId)}><span className="truncate">{accountName(account)}</span></span>
    <span className={fade(showId)} aria-hidden="true">
      <span className="truncate tabular-nums"><span className="font-normal text-muted-foreground select-none">UserId</span> <span className="select-text">{account.id}</span></span>
    </span>
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
  return <Panel className={cn("flex items-center gap-3", className)} {...props}>
    {leading}
    {showAvatar && <Avatar account={account} className={avatarClassName} />}
    <div className="min-w-0 flex-1">
      {eyebrow}
      <div className="flex min-w-0 items-center gap-2">
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
  const place = account.gamePlaceId ? `(${account.gamePlaceId})` : "";
  return account.gameName ? `In game: ${account.gameName} ${place}`.trim() : place ? `In game ${place}` : "In game";
};

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

export function SwitchRow({ title, description, checked, change }: { title: string; description?: string; checked: boolean; change: (value: boolean) => void }) {
  return <SettingRow title={title} description={description} control={(labelId, descriptionId) => <Switch checked={checked} onCheckedChange={(value) => change(value)} aria-labelledby={labelId} aria-describedby={descriptionId} />} />;
}

export function ChoiceRow<T extends string>({ title, description, value, options, change }: { title: string; description?: string; value: T; options: { value: T; label: string }[]; change: (value: T) => void }) {
  return <SettingRow title={title} description={description} control={(labelId) => <ToggleGroup variant="outline" size="sm" value={[value]} onValueChange={(values) => { if (values[0]) change(values[0] as T); }} aria-labelledby={labelId}>
    {options.map((option) => <ToggleGroupItem key={option.value} value={option.value} className="px-3">{option.label}</ToggleGroupItem>)}
  </ToggleGroup>} />;
}

export function StatTile({ icon, label, value, onClick }: { icon: ReactNode; label: string; value: ReactNode; onClick?: () => void }) {
  const body = <>
    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4" aria-hidden="true">{icon}</span>
    <span className="min-w-0">
      <span className="block text-xl leading-tight font-semibold tabular-nums">{value}</span>
      <span className="block truncate text-xs text-muted-foreground">{label}</span>
    </span>
  </>;
  const className = "flex items-center gap-3 rounded-xl bg-card p-4 text-left ring-1 ring-foreground/8";
  return onClick
    ? <button onClick={onClick} className={cn(className, "outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50")}>{body}</button>
    : <div className={className}>{body}</div>;
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
    <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">{icon}</span>
    <div className="space-y-1"><h2 className="text-sm font-medium">{title}</h2><p className="max-w-xs text-sm text-muted-foreground">{text}</p></div>
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
