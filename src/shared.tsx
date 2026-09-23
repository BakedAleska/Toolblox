import { LoaderCircle, UserRound } from "lucide-react";
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { bridge } from "@/bridge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Account, AppRoute, AppState, Settings, WidgetSummary } from "@/types";

export type PlaceRequest = { title: string; description: string; action: string; run: (placeId: string) => Promise<void> };

/** A place's game name when Toolblox knows it, otherwise its ID. */
export const placeLabel = (state: AppState, placeId: string) => state.recentPlaces.find((place) => place.placeId === placeId)?.name || placeId;

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

/** Scrolling page with a sticky header, width-capped so fullscreen stays readable. */
export function Screen({ title, actions, children, className }: { title: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
    <div className={cn("mx-auto flex min-h-full max-w-5xl flex-col gap-4 px-6 pb-6", className)}>
      <header className="sticky top-0 z-10 -mx-6 flex h-14 shrink-0 items-center gap-2 bg-background/90 px-6 backdrop-blur-sm">
        <h1 className="mr-auto shrink-0 pr-2 text-lg font-semibold tracking-tight">{title}</h1>
        {actions}
      </header>
      {children}
    </div>
  </div>;
}

export function Panel({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-xl bg-card ring-1 ring-foreground/8", className)} {...props} />;
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

export const presenceLabel = (account: Account) => {
  if (account.presence === "warning") return "Status unavailable";
  if (account.presence !== "playing") return "";
  const place = account.gamePlaceId ? `(${account.gamePlaceId})` : "";
  return account.gameName ? `In game: ${account.gameName} ${place}`.trim() : place ? `In game ${place}` : "In game";
};

function SettingRow({ title, description, control }: { title: string; description?: string; control: (labelId: string, descriptionId?: string) => ReactNode }) {
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
