import { ChevronRight, CircleAlert, CircleCheck, CircleArrowUp, Gamepad2, KeyRound, MapPin, Play, Plus, Puzzle, Users } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { accountName, relativeTime, sortAccounts } from "@/logic";
import { AccountCard, Avatar, Panel, SectionTitle, Screen, StatTile, WidgetFrame, placeLabel, presenceLabel, type ScreenProps } from "@/shared";
import type { Account, AppRoute } from "@/types";
import { WidgetSlot } from "@/widgets/host";

/** How many 40-pixel rows, with the list gap between them, fit in a list. Lists fill the space
 * above the footer, so the dashboard never scrolls and taller windows show more rows before the
 * rest collapse into a link. */
function useRowCapacity() {
  const ref = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(3);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const gap = parseFloat(getComputedStyle(element).rowGap) || 0;
      setCapacity(Math.max(1, Math.floor((entry.contentRect.height + gap) / (40 + gap))));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, capacity] as const;
}

/** Windows much taller than the default 900 by 500, such as fullscreen, or much narrower than its
 * 9:5 shape list every row at a fixed height instead of filling the space, so nothing stretches.
 * Windows near the default fill it completely. */
const roomyQuery = "(min-height: 601px), (max-aspect-ratio: 7/5)";
const subscribeRoomy = (change: () => void) => {
  const media = window.matchMedia(roomyQuery);
  media.addEventListener("change", change);
  return () => media.removeEventListener("change", change);
};
const useRoomy = () => useSyncExternalStore(subscribeRoomy, () => window.matchMedia(roomyQuery).matches);

/** The rows that fit in `capacity`, leaving room for the link to the rest. */
const fitRows = <T,>(rows: T[], capacity: number) => rows.length > capacity ? rows.slice(0, capacity - 1) : rows;

export function Dashboard({ state, navigate, join, signIn }: ScreenProps) {
  const { accounts, settings, installedWidgets } = state;
  const hero = sortAccounts(accounts, "last_played")[0];
  const playing = accounts.filter(({ presence }) => presence === "playing");
  const enabledWidgets = installedWidgets.filter(({ enabled }) => enabled);
  const place = hero?.placeId || settings.placeId;
  const [gamesList, gamesCapacity] = useRowCapacity();
  const [attentionList, attentionCapacity] = useRowCapacity();
  const roomy = useRoomy();

  const games = new Map<string, Account[]>();
  for (const account of sortAccounts(playing, "last_played")) {
    const key = account.gamePlaceId ? String(account.gamePlaceId) : "";
    games.set(key, [...games.get(key) ?? [], account]);
  }
  const gameLabel = (placeId: string, players: Account[]) => players[0].gameName || (placeId ? placeLabel(state, placeId) : "Unknown game");

  const expired = accounts.filter(({ sessionExpired }) => sessionExpired).length;
  const unavailable = accounts.filter(({ presence, sessionExpired }) => presence === "warning" && !sessionExpired).length;
  const updates = installedWidgets.filter(({ version, availableVersion }) => availableVersion && availableVersion !== version).length;
  const placeless = !settings.placeId && accounts.some(({ placeId }) => !placeId);
  const attention: { icon: ReactNode; text: string; route: AppRoute }[] = [
    ...expired ? [{ icon: <KeyRound className="text-warning" />, text: `${expired} ${expired === 1 ? "session" : "sessions"} expired`, route: "/accounts" as const }] : [],
    ...unavailable ? [{ icon: <CircleAlert className="text-warning" />, text: `Status unavailable for ${unavailable} ${unavailable === 1 ? "account" : "accounts"}`, route: "/accounts" as const }] : [],
    ...updates ? [{ icon: <CircleArrowUp />, text: `${updates} widget ${updates === 1 ? "update" : "updates"}`, route: "/widgets" as const }] : [],
    ...placeless && accounts.length ? [{ icon: <MapPin />, text: "No default place", route: "/accounts" as const }] : [],
  ];

  const gameRows = roomy ? Infinity : gamesCapacity;
  const attentionRows = roomy ? Infinity : attentionCapacity;
  const row = roomy ? "h-12" : "min-h-10 flex-1";

  return <Screen title="Dashboard">
    {hero ? <AccountCard account={hero} showAvatar={settings.showAvatars} avatarClassName="size-14" nameClassName="text-lg font-semibold tracking-tight"
      className="flex-wrap gap-4 rounded-2xl p-5" eyebrow={<p className="text-xs text-muted-foreground">Continue as</p>}
      actions={hero.sessionExpired
        ? <Button size="lg" className="px-4" onClick={() => void signIn(hero.id)}><KeyRound />Sign in again</Button>
        : <Button size="lg" className="px-4" onClick={() => join([hero.id])}><Play />Join</Button>}>
      <p className="truncate text-xs text-muted-foreground">
        {presenceLabel(hero) || <>{relativeTime(hero.lastPlayedAt)}{place && ` · ${placeLabel(state, place)}`}</>}
      </p>
    </AccountCard> : <Panel className="flex flex-wrap items-center gap-4 rounded-2xl p-5">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">No accounts</p>
        <p className="text-sm text-muted-foreground">Add a Roblox account to begin.</p>
      </div>
      <Button size="lg" className="px-4" onClick={() => navigate("/accounts")}><Plus />Add account</Button>
    </Panel>}

    <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-list">
      <StatTile icon={<Users />} label="Accounts" value={accounts.length} onClick={() => navigate("/accounts")} />
      <StatTile icon={<Gamepad2 />} label="In game" value={playing.length} onClick={() => navigate("/accounts")} />
      <StatTile icon={<Puzzle />} label="Widgets enabled" value={`${enabledWidgets.length}/${installedWidgets.length}`} onClick={() => navigate("/widgets")} />
      <WidgetSlot name="dashboard.stats" props={{}} />
    </div>

    {accounts.length > 0 && <div className={cn("grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-list", roomy ? "items-start" : "min-h-0 flex-1 basis-0 auto-rows-[minmax(0,1fr)]")}>
      <section className="flex min-h-0 flex-col gap-2">
        <SectionTitle>Now playing</SectionTitle>
        <div ref={gamesList} className="flex min-h-0 flex-1 flex-col gap-list">
          {games.size === 0 && <EmptyRow icon={<Gamepad2 />} text="No accounts in game" plain={roomy} />}
          {fitRows([...games], gameRows).map(([placeId, players]) => <Panel key={placeId} className={cn("flex items-center gap-3 px-4", row)}>
            <p className="min-w-0 flex-1 truncate text-sm" title={placeId ? `Place ID ${placeId}` : undefined}>
              <span className="font-medium">{gameLabel(placeId, players)}</span>
              <span className="text-xs text-muted-foreground"> · {players.map(accountName).join(", ")}</span>
            </p>
            {settings.showAvatars && <span className="flex shrink-0 -space-x-2">
              {players.slice(0, 3).map((account) => <Avatar key={account.id} account={account} status={false} className="size-6 ring-2 ring-card" />)}
            </span>}
          </Panel>)}
          {games.size > gameRows && <MoreRow text={`${games.size - gameRows + 1} more games`} onClick={() => navigate("/accounts")} />}
        </div>
      </section>
      <section className="flex min-h-0 flex-col gap-2">
        <SectionTitle>Needs attention</SectionTitle>
        <div ref={attentionList} className="flex min-h-0 flex-1 flex-col gap-list">
          {attention.length === 0 && <EmptyRow icon={<CircleCheck className="text-success" />} text="All clear" plain={roomy} />}
          {fitRows(attention, attentionRows).map(({ icon, text, route }) => <button key={text} type="button" onClick={() => navigate(route)}
            className={cn("flex items-center gap-3 rounded-xl bg-card px-4 text-left text-sm ring-1 ring-foreground/8 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0", row)}>
            {icon}<span className="min-w-0 flex-1 truncate">{text}</span><ChevronRight className="text-muted-foreground" aria-hidden="true" />
          </button>)}
          {attention.length > attentionRows && <MoreRow text={`${attention.length - attentionRows + 1} more`} onClick={() => navigate("/accounts")} />}
        </div>
      </section>
    </div>}

    <WidgetSlot name="dashboard.sections" props={{}} wrap={(children) => <div className="flex flex-col gap-4">{children}</div>} />

    {enabledWidgets.filter((widget) => widget.hasDashboardTile).map((widget) => <section key={widget.id} className="flex flex-col gap-2">
      <SectionTitle>{widget.name}</SectionTitle>
      <WidgetFrame widget={widget} surface="dashboard" title={`${widget.name} dashboard`} />
    </section>)}

  </Screen>;
}

/** A list's empty state: a card filling the list, or a plain line when `plain`. */
function EmptyRow({ icon, text, plain }: { icon: ReactNode; text: string; plain: boolean }) {
  return plain
    ? <p className="flex h-12 items-center gap-2 text-sm text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0">{icon}{text}</p>
    : <Panel className="flex min-h-10 flex-1 flex-col items-center justify-center gap-2 px-4 py-3 text-sm text-muted-foreground [&_svg]:size-5 [&_svg]:shrink-0">{icon}{text}</Panel>;
}

function MoreRow({ text, onClick }: { text: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="flex h-8 items-center rounded-lg px-4 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">{text}</button>;
}
