import { ChevronRight, CircleAlert, CircleArrowUp, Gamepad2, KeyRound, MapPin, Play, Plus, Puzzle, Star, TriangleAlert, Users } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { accountName, relativeTime, sortAccounts } from "@/logic";
import { AccountCard, IconButton, Panel, Screen, SectionTitle, Spinner, StatTile, WidgetFrame, placeLabel, presenceLabel, type ScreenProps } from "@/shared";
import { showAccountMenu } from "@/screens/Accounts";
import type { AppRoute } from "@/types";
import { WidgetSlot } from "@/widgets/host";

type Severity = "destructive" | "warning" | "neutral";
const severityStyles: Record<Severity, string> = {
  destructive: "bg-destructive/10 ring-destructive/25 hover:bg-destructive/15 [&>svg:first-child]:text-destructive",
  warning: "bg-warning/10 ring-warning/25 hover:bg-warning/15 [&>svg:first-child]:text-warning",
  neutral: "bg-card ring-foreground/8 hover:bg-muted/50 [&>svg:first-child]:text-muted-foreground",
};

/** Whether a scrolling element has more content below what's visible. */
function useMoreBelow(shown: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setMore(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("scroll", update, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener("scroll", update); };
  }, [shown]);
  return [ref, more] as const;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function Dashboard({ state, navigate, join, joining, signIn }: ScreenProps) {
  const { accounts, settings, installedWidgets } = state;
  const [hero] = sortAccounts(accounts, "last_played");
  const pinned = sortAccounts(accounts, settings.sortOrder).filter((account) => account.pinned);
  const playing = accounts.filter(({ presence }) => presence === "playing");
  const enabledWidgets = installedWidgets.filter(({ enabled }) => enabled);
  const place = hero?.placeId || settings.placeId;
  const [pinnedGrid, moreBelow] = useMoreBelow(pinned.length > 0);

  const expired = accounts.filter(({ sessionExpired }) => sessionExpired).length;
  const unavailable = accounts.filter(({ presence, sessionExpired }) => presence === "warning" && !sessionExpired).length;
  const updates = installedWidgets.filter(({ version, availableVersion }) => availableVersion && availableVersion !== version).length;
  const failed = state.widgetErrors.length;
  const placeless = !settings.placeId && accounts.some(({ placeId }) => !placeId);
  const issues: { severity: Severity; icon: ReactNode; title: string; action: string; route: AppRoute }[] = [
    ...expired ? [{ severity: "destructive" as const, icon: <KeyRound />, title: `${plural(expired, "session", "sessions")} expired`, action: "Sign in again", route: "/accounts" as const }] : [],
    ...failed ? [{ severity: "destructive" as const, icon: <TriangleAlert />, title: `${plural(failed, "widget", "widgets")} failed to load`, action: "Review", route: "/widgets" as const }] : [],
    ...unavailable ? [{ severity: "warning" as const, icon: <CircleAlert />, title: `Status unavailable for ${plural(unavailable, "account", "accounts")}`, action: "Review", route: "/accounts" as const }] : [],
    ...placeless && accounts.length ? [{ severity: "warning" as const, icon: <MapPin />, title: "No default place", action: "Set place", route: "/accounts" as const }] : [],
    ...updates ? [{ severity: "neutral" as const, icon: <CircleArrowUp />, title: `${plural(updates, "widget update", "widget updates")} available`, action: "Update", route: "/widgets" as const }] : [],
  ];

  return <Screen title="Dashboard" className="gap-4">
    <div className="grid gap-4 @5xl:grid-cols-[3fr_2fr]">
      {hero ? <AccountCard account={hero} showAvatar={settings.showAvatars} avatarClassName="size-14" nameClassName="text-lg font-semibold tracking-tight"
        className="flex-wrap gap-4 rounded-2xl p-6" eyebrow={<p className="text-xs font-medium text-muted-foreground">Continue as</p>}
        actions={hero.sessionExpired
          ? <Button size="lg" className="px-4" onClick={() => void signIn(hero.id)}><KeyRound />Sign in again</Button>
          : <Button size="lg" className="px-4" disabled={joining.includes(hero.id)} aria-label={`Join as ${accountName(hero)}`} onClick={() => join([hero.id])}>{joining.includes(hero.id) ? <Spinner /> : <Play />}Join</Button>}>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {presenceLabel(hero) || <>{relativeTime(hero.lastPlayedAt)}{place && ` · ${placeLabel(state, place)}`}</>}
        </p>
      </AccountCard> : <Panel className="flex flex-wrap items-center gap-4 rounded-2xl p-6">
        <p className="min-w-0 flex-1 font-semibold">No accounts</p>
        <Button size="lg" className="px-4" onClick={() => navigate("/accounts")}><Plus />Add account</Button>
      </Panel>}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-list">
        <StatTile icon={<Users />} label="Accounts" value={accounts.length} onClick={() => navigate("/accounts")} />
        <StatTile icon={<Gamepad2 />} label="In game" value={playing.length} onClick={() => navigate("/accounts")} />
        <StatTile icon={<Puzzle />} label="Widgets enabled" value={`${enabledWidgets.length}/${installedWidgets.length}`} onClick={() => navigate("/widgets")} />
        <WidgetSlot name="dashboard.stats" props={{}} />
      </div>
    </div>

    {issues.length > 0 && <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-list">
      {issues.map(({ severity, icon, title, action, route }) => <button key={title} type="button" title={title} onClick={() => navigate(route)}
        className={cn("@container flex h-10 min-w-0 items-center gap-3 rounded-xl px-4 text-left text-sm ring-1 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0", severityStyles[severity])}>
        {icon}<span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <span className="shrink-0 text-xs text-muted-foreground @max-[18rem]:hidden">{action}</span><ChevronRight className="text-muted-foreground" aria-hidden="true" />
      </button>)}
    </div>}

    {accounts.length > 0 && <section aria-label="Pinned" className="flex min-h-28 flex-1 basis-0 flex-col gap-2">
        <SectionTitle action={<Button variant="ghost" size="sm" className="-mr-2.5 text-muted-foreground" onClick={() => navigate("/accounts")}>
          View all<ChevronRight data-icon="inline-end" aria-hidden="true" />
        </Button>}>Pinned</SectionTitle>
        {pinned.length ? <div ref={pinnedGrid} className={cn("grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] content-start gap-list overflow-y-auto rounded-xl border border-dashed p-2 [scrollbar-gutter:stable]", moreBelow && "mask-b-from-70%")}>
          {pinned.map((account) => <AccountCard key={account.id} account={account} showAvatar={settings.showAvatars}
            avatarClassName={settings.compactMode ? "size-8" : "size-10"} className={settings.compactMode ? "h-12 py-2" : "h-16"}
            actions={account.sessionExpired
              ? <IconButton label={`Sign in again as ${accountName(account)}`} size="icon-sm" onClick={() => void signIn(account.id)}><KeyRound /></IconButton>
              : <IconButton label={`Join as ${accountName(account)}`} size="icon-sm" disabled={joining.includes(account.id)} onClick={() => join([account.id])}>{joining.includes(account.id) ? <Spinner /> : <Play />}</IconButton>}>
            {!settings.compactMode && <p className="truncate text-xs text-muted-foreground">{presenceLabel(account) || relativeTime(account.lastPlayedAt)}</p>}
          </AccountCard>)}
        </div>
          : <div className="flex min-h-0 flex-1 flex-wrap items-center justify-center gap-x-4 gap-y-2 overflow-hidden rounded-xl border border-dashed px-4 py-3 text-center">
            <p className="min-w-0 text-sm font-medium">No pinned accounts</p>
            <Button variant="outline" size="sm" onClick={() => { showAccountMenu(); navigate("/accounts"); }}><Star />Pin accounts</Button>
          </div>}
    </section>}

    <WidgetSlot name="dashboard.sections" props={{}} wrap={(children) => <div className="flex flex-col gap-4">{children}</div>} />

    {enabledWidgets.filter((widget) => widget.hasDashboardTile).map((widget) => <section key={widget.id} className="flex flex-col gap-2">
      <SectionTitle>{widget.name}</SectionTitle>
      <WidgetFrame widget={widget} surface="dashboard" title={`${widget.name} dashboard`} />
    </section>)}

  </Screen>;
}
