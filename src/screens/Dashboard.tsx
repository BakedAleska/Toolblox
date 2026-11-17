import { ChevronRight, CircleAlert, CircleArrowUp, KeyRound, MapPin, Play, Plus, Star, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { bridge } from "@/bridge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { accountName, relativeTime, sortAccounts } from "@/logic";
import { AccountCard, AccountName, Avatar, Hint, IconButton, Panel, Screen, SectionTitle, Spinner, WidgetFrame, placeLabel, presenceLabel, type ScreenProps } from "@/shared";
import { showAccountMenu } from "@/screens/Accounts";
import type { Account, AppRoute, OnlineFriend } from "@/types";
import { WidgetSlot } from "@/widgets/host";
import { GroupCard } from "@/screens/Groups";

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

/** An online friend and the account whose friend list found them, which joins them. */
type SeenFriend = OnlineFriend & { via: number };

/** The online friends of the accounts, refreshed every minute, in-game first. A friend of several
 * accounts appears once. `undefined` while loading. A refresh where every account fails keeps the
 * last list. */
function useOnlineFriends(accountIds: number[]) {
  const [friends, setFriends] = useState<SeenFriend[] | "failed">();
  const key = accountIds.join(",");
  useEffect(() => {
    setFriends(accountIds.length ? undefined : "failed");
    if (!accountIds.length) return;
    let active = true;
    const load = async () => {
      const results = await Promise.allSettled(accountIds.map((id) => bridge.getOnlineFriends(id).then((found) => found.map((friend) => ({ ...friend, via: id })))));
      if (!active) return;
      if (results.every(({ status }) => status === "rejected")) { setFriends((current) => Array.isArray(current) ? current : "failed"); return; }
      const merged = new Map<number, SeenFriend>();
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        for (const friend of result.value) if (!accountIds.includes(friend.id) && (!merged.has(friend.id) || (friend.inGame && !merged.get(friend.id)!.inGame))) merged.set(friend.id, friend);
      }
      setFriends([...merged.values()].sort((a, b) => Number(b.inGame) - Number(a.inGame) || a.displayName.localeCompare(b.displayName)));
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [key]);
  return friends;
}

const friendAccount = ({ inGame, ...friend }: OnlineFriend): Account => ({ ...friend, notes: "", addedAt: 0, presence: inGame ? "playing" : "offline" });

const cardGrid = "grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] content-start gap-list overflow-y-auto p-px [scrollbar-gutter:stable]";
const emptySection = "flex min-h-0 flex-1 flex-wrap items-center justify-center gap-x-4 gap-y-2 overflow-hidden rounded-xl border border-dashed px-4 py-3 text-center";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function Dashboard({ state, navigate, join, joining, cancelJoin, signIn }: ScreenProps) {
  const { accounts, settings, installedWidgets } = state;
  const [hero] = sortAccounts(accounts, "last_played");
  const pinned = sortAccounts(accounts, settings.sortOrder).filter((account) => account.pinned);
  const enabledWidgets = installedWidgets.filter(({ enabled }) => enabled);
  const place = hero?.placeId || settings.placeId;
  const pinnedGroups = (settings.groups ?? []).filter(({ pinned: isPinned }) => isPinned);
  const [pinnedGrid, moreBelow] = useMoreBelow(pinned.length + pinnedGroups.length > 0);
  const signedIn = accounts.filter(({ sessionExpired }) => !sessionExpired);
  const friendSources = settings.friendsSource === "all" ? signedIn
    : settings.friendsSource === "pinned" && signedIn.some(({ pinned: isPinned }) => isPinned) ? signedIn.filter(({ pinned: isPinned }) => isPinned)
    : hero && !hero.sessionExpired ? [hero] : [];
  const friends = useOnlineFriends(friendSources.map(({ id }) => id));
  const hasFriends = Array.isArray(friends) && friends.length > 0;

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

  return <Screen title="Dashboard" className="gap-3">
      {hero ? <AccountCard account={hero} showAvatar={settings.showAvatars} avatarClassName="size-14" nameClassName="text-lg font-semibold tracking-tight"
        className="flex-wrap gap-4 rounded-2xl p-3" eyebrow={<p className="text-xs font-medium text-muted-foreground">Continue as</p>}
        actions={hero.sessionExpired
          ? <Button size="lg" className="px-4" onClick={() => void signIn(hero.id)}><KeyRound />Sign in again</Button>
          : <Button size="lg" className="px-4" aria-label={joining.includes(hero.id) ? `Cancel the join for ${accountName(hero)}` : `Join as ${accountName(hero)}`}
            onClick={() => joining.includes(hero.id) ? cancelJoin([hero.id]) : join([hero.id])}>{joining.includes(hero.id) ? <><Spinner />Cancel</> : <><Play />Join</>}</Button>}>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {presenceLabel(hero) || <>{relativeTime(hero.lastPlayedAt)}{place && ` · ${placeLabel(state, place)}`}</>}
        </p>
      </AccountCard> : <Panel className="flex flex-wrap items-center gap-4 rounded-2xl p-3">
        <p className="min-w-0 flex-1 font-semibold">No accounts</p>
        <Button size="lg" className="px-4" onClick={() => navigate("/accounts")}><Plus />Add account</Button>
      </Panel>}

      <WidgetSlot name="dashboard.stats" props={{}} wrap={(children) => <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-list">{children}</div>} />

    {accounts.length > 0 && <section aria-label="Pinned" className="flex min-h-24 flex-1 basis-0 flex-col gap-1">
        <SectionTitle action={<Button variant="ghost" size="sm" className="-mr-2.5 text-muted-foreground" onClick={() => navigate("/accounts")}>
          View all<ChevronRight data-icon="inline-end" aria-hidden="true" />
        </Button>}>Pinned</SectionTitle>
        {pinned.length + pinnedGroups.length ? <div ref={pinnedGrid} className={cn(cardGrid, moreBelow && "mask-b-from-70%")}>
          {pinnedGroups.map((group) => <GroupCard key={group.id} state={state} join={join} joining={joining} cancelJoin={cancelJoin} group={group} simple
            className={settings.compactMode ? "h-12 py-2" : "h-14 py-2"} />)}
          {pinned.map((account) => <AccountCard key={account.id} account={account} showAvatar={settings.showAvatars}
            avatarClassName={settings.compactMode ? "size-8" : "size-9"} className={settings.compactMode ? "h-12 py-2" : "h-14 py-2"}
            actions={account.sessionExpired
              ? <IconButton label={`Sign in again as ${accountName(account)}`} size="icon-sm" onClick={() => void signIn(account.id)}><KeyRound /></IconButton>
              : <IconButton label={joining.includes(account.id) ? `Cancel the join for ${accountName(account)}` : `Join as ${accountName(account)}`} size="icon-sm"
                onClick={() => joining.includes(account.id) ? cancelJoin([account.id]) : join([account.id])}>{joining.includes(account.id) ? <Spinner /> : <Play />}</IconButton>}>
            {!settings.compactMode && <p className="truncate text-xs text-muted-foreground">{presenceLabel(account) || relativeTime(account.lastPlayedAt)}</p>}
          </AccountCard>)}
        </div>
          : <div className={emptySection}>
            <p className="min-w-0 text-sm font-medium">No pinned accounts</p>
            <Button variant="outline" size="sm" onClick={() => { showAccountMenu(); navigate("/accounts"); }}><Star />Pin accounts</Button>
          </div>}
    </section>}

    {accounts.length > 0 && <section aria-label="Online friends" className="flex shrink-0 flex-col gap-1">
      <h2 className="text-sm font-medium text-muted-foreground">Online friends</h2>
      {hasFriends ? <ul className="flex h-14 gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]" onWheel={(event) => { event.currentTarget.scrollLeft += event.deltaY; }}>
        {friends.map(({ via, ...online }) => {
          const friend = friendAccount(online);
          const status = presenceLabel(friend) || "Online";
          const joiner = accounts.find(({ id }) => id === via);
          const joinable = joiner && online.inGame && !online.inStudio;
          return <li key={friend.id} className="w-16 shrink-0">
            <Tooltip>
              <TooltipTrigger aria-label={joinable ? `Join ${accountName(friend)} as ${accountName(joiner)}: ${status}` : `${accountName(friend)}: ${status}`}
                disabled={joinable ? joining.includes(joiner.id) : undefined} onClick={joinable ? () => join([joiner.id], `@${friend.id}`) : undefined}
                className={cn("flex w-full flex-col items-center gap-1 rounded-lg text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring", joinable && "cursor-pointer hover:bg-muted/50")}>
                {settings.showAvatars && <Avatar account={friend} className="size-9" />}
                <AccountName account={friend} />
              </TooltipTrigger>
              <TooltipContent>{joinable ? `${status}. Joins as ${accountName(joiner)}.` : status}</TooltipContent>
            </Tooltip>
          </li>;
        })}
      </ul>
        : friends === undefined ? <ul className="flex h-14 flex-wrap gap-1 overflow-hidden" role="status" aria-label="Loading friends">
          {Array.from({ length: 32 }, (_, index) => <li key={index} className="flex h-14 w-16 shrink-0 flex-col items-center justify-center gap-1">
            {settings.showAvatars && <Skeleton className="size-9 rounded-full" />}<Skeleton className="h-3 w-12" />
          </li>)}
        </ul>
        : <div className={cn(emptySection, "h-14 flex-none")}>
          <p className="min-w-0 text-sm font-medium">{friends === "failed" ? "Friends unavailable" : "No friends online"}</p>
        </div>}
    </section>}

    {issues.length > 0 && <div className="grid auto-cols-fr grid-flow-col gap-list">
      {issues.map(({ severity, icon, title, action, route }) => <Hint key={title} label={title}><button type="button" onClick={() => navigate(route)}
        className={cn("@container flex h-10 min-w-0 items-center gap-3 rounded-xl px-4 text-left text-sm ring-1 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0", severityStyles[severity])}>
        {icon}<span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <span className="shrink-0 text-xs text-muted-foreground @max-[18rem]:hidden">{action}</span><ChevronRight className="text-muted-foreground" aria-hidden="true" />
      </button></Hint>)}
    </div>}

    <WidgetSlot name="dashboard.sections" props={{}} wrap={(children) => <div className="flex flex-col gap-4">{children}</div>} />

    {enabledWidgets.filter((widget) => widget.hasDashboardTile).map((widget) => <section key={widget.id} className="flex flex-col gap-2">
      <SectionTitle>{widget.name}</SectionTitle>
      <WidgetFrame widget={widget} surface="dashboard" title={`${widget.name} dashboard`} />
    </section>)}

  </Screen>;
}
