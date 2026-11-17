import { ArrowLeft, BadgeCheck, Ban, BellOff, BellPlus, ChevronDown, Clock, ExternalLink, Eye, Gamepad2, Heart, MapPinOff, Repeat1, RotateCcw, Search, ShieldOff, ThumbsUp, UserRound, X, UserRoundCheck, UserRoundMinus, UserRoundPlus, UserRoundX, Users } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { lift } from "@/lib/motion";
import { bridge } from "@/bridge";
import { accountName, parseJoinTarget, parsePlaceId, sortAccounts, targetUserId } from "@/logic";
import { Avatar, EmptyState, IconButton, Screen, Spinner, TargetKindToggle, failure, placeLabel, usePlaceSearch, usePlayerSearch, type ScreenProps } from "@/shared";
import type { Account, PlayerMatch, Relationship, SocialAction } from "@/types";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Updated Oct 28, 2026", or nothing when Roblox sent no valid date. */
const updatedLabel = (updated?: string) => {
  const date = updated ? new Date(updated) : undefined;
  return date && !Number.isNaN(date.getTime()) ? `Updated ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : undefined;
};

type Kind = "games" | "players";

/** The search text, kept when switching between the games and players pages. */
let lastQuery = "";

/** The account whose own destination the next search sets. Unset, the search sets the default. */
let destinationAccount: number | undefined;
export const searchDestinationFor = (accountId: number) => { destinationAccount = accountId; };

/** The group whose destination the next search sets. */
let destinationGroup: string | undefined;
export const searchGroupDestinationFor = (groupId: string) => { destinationGroup = groupId; };

/** Set when a default destination is saved, so Accounts shows it beside the pin for a moment. */
export const destinationPeek = { pending: false };

/** Finds a game or player by name and sets it as the default destination, or as one account's
 * after `searchDestinationFor`. Games and players are separate pages. Players can also be
 * friended, followed, and blocked as one of the accounts. */
export function PlaceSearch({ state: appState, ...rest }: ScreenProps & { kind: Kind }) {
  const { navigate, patchSettings, refresh, notify, kind } = rest;
  const [forAccount] = useState(() => appState.accounts.find(({ id }) => id === destinationAccount));
  const [forGroup] = useState(() => appState.settings.groups.find(({ id }) => id === destinationGroup));
  useEffect(() => () => { destinationAccount = undefined; destinationGroup = undefined; }, []);
  /** The results mark the destination being changed as current. */
  const current = forGroup ? forGroup.placeId : forAccount ? forAccount.placeId : appState.settings.placeId;
  const state = forAccount || forGroup ? { ...appState, settings: { ...appState.settings, placeId: current ?? "" } } : appState;
  const props = { ...rest, state };
  const [query, setQueryState] = useState(lastQuery);
  const setQuery = (text: string) => { lastQuery = text; setQueryState(text); };
  const places = usePlaceSearch(kind === "games" ? query : "");
  const players = usePlayerSearch(kind === "players" ? query : "");
  const parsed = parseJoinTarget(query);
  const typed = kind === "players" ? (targetUserId(parsed) !== undefined ? parsed : undefined) : parsePlaceId(query);
  const accounts = sortAccounts(state.accounts, state.settings.sortOrder);
  const [actorId, setActorId] = useState(() => (accounts.find((account) => !account.sessionExpired) ?? accounts[0])?.id);
  const actor = accounts.find((account) => account.id === actorId);
  const actorField = useRef<HTMLButtonElement>(null);
  /** When set, a pick is a one-time destination for the next join instead of the saved one. */
  const [once, setOnce] = useState(false);
  const nameOf = (target: string) => {
    const player = players.matches.find(({ id }) => `@${id}` === target);
    return places.matches.find(({ placeId }) => placeId === target)?.name ?? (player ? `@${player.name}` : placeLabel(appState, target));
  };
  const choose = (target: string) => {
    if (once) {
      const name = nameOf(target);
      rest.setNextJoin(forAccount?.id ?? "default", { target, name });
      if (!forAccount) destinationPeek.pending = true;
      rest.done(forAccount ? `Next join for ${accountName(forAccount)}: ${name}.` : `Next join: ${name}.`);
    }
    else if (forGroup) {
      void patchSettings("groups", appState.settings.groups.map((group) => group.id === forGroup.id ? { ...group, placeId: target } : group));
      rest.done(`Destination saved for ${forGroup.name}.`);
    }
    else if (forAccount) void bridge.setAccountPlace(forAccount.id, target).then(() => { rest.done(`Destination saved for ${accountName(forAccount)}.`); return refresh(); }).catch((error) => notify(failure(`The destination wasn't saved. Does retrying help?`, error)));
    else { destinationPeek.pending = true; void patchSettings("placeId", target); }
    navigate("/accounts");
  };
  const firstMatch = kind === "games" ? places.matches[0]?.placeId : players.matches[0] && `@${players.matches[0].id}`;
  const FieldIcon = kind === "games" ? Gamepad2 : UserRound;

  return <Screen title={forGroup ? `Destination for ${forGroup.name}` : forAccount ? `Destination for ${accountName(forAccount)}` : kind === "games" ? "Find a game" : "Find a player"} actions={<IconButton label="Back to accounts" onClick={() => navigate("/accounts")}><ArrowLeft /></IconButton>} toolbar={<>
    <form role="search" className="relative min-w-40 flex-1" onSubmit={(event) => { event.preventDefault(); const target = typed || firstMatch; if (target) choose(target); }}>
      <TargetKindToggle kind={kind === "players" ? "player" : "place"} gameIcon={<Gamepad2 />} className="left-1.5 h-7"
        toggle={() => navigate(kind === "games" ? "/accounts/players" : "/accounts/places")} />
      <Input autoFocus type="search" name="place-search" value={query} placeholder={kind === "games" ? "Game name, link, or place ID" : "Username, display name, or profile link"}
        aria-label={kind === "games" ? "Search Roblox games" : "Search Roblox players"} spellCheck={false} autoComplete="off"
        className={cn("h-10 pl-14 text-base", kind === "players" && "bg-muted/50")} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape" && !query) navigate("/accounts"); }} />
    </form>
    {!forGroup && <Tooltip>
      <TooltipTrigger render={<Toggle variant="outline" className="size-10" pressed={once} onPressedChange={setOnce}
        aria-label={once ? "Next join only is on. Picks set a one-time destination" : "Next join only. Picks set a one-time destination"} />}>
        <Repeat1 />
      </TooltipTrigger>
      <TooltipContent>{once ? "Next join only: on" : "Next join only"}</TooltipContent>
    </Tooltip>}
    {!forAccount && !forGroup && appState.settings.placeId && <Button variant="outline" className="h-10" onClick={() => { void patchSettings("placeId", ""); rest.done("No default destination. Accounts show their general notes and tags."); navigate("/accounts"); }}>
      <MapPinOff />No default
    </Button>}
    {kind === "players" && accounts.length > 0 && <DropdownMenu>
      <DropdownMenuTrigger render={<Button ref={actorField} variant="outline" className="h-10 max-w-48" aria-label={`Acting account: ${actor ? accountName(actor) : "none"}`} />}>
        {actor && state.settings.showAvatars && <Avatar account={actor} className="size-6" status={false} />}
        <span className="min-w-0 truncate">{actor ? accountName(actor) : "Choose account"}</span>
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent anchor={actorField} align="start" arrow={false} className="min-w-0">
        <DropdownMenuRadioGroup value={actorId} onValueChange={(value) => setActorId(value as number)}>
          <DropdownMenuLabel>Acting account</DropdownMenuLabel>
          {accounts.map((account) => <DropdownMenuRadioItem key={account.id} value={account.id} disabled={account.sessionExpired}>
            <span className="min-w-0 truncate">{accountName(account)}</span>
          </DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>}
  </>}>
    {typed ? <ResultButton onClick={() => choose(typed)}>
      <span className={cn("grid size-10 shrink-0 place-items-center bg-muted text-muted-foreground", kind === "players" ? "rounded-full" : "rounded-lg")} aria-hidden="true"><FieldIcon className="size-5" /></span>
      <span className="min-w-0 flex-1 text-sm font-medium">{kind === "games" ? "Use place" : "Use player"} <span className="font-mono">{kind === "games" ? typed : typed.slice(1)}</span></span>
    </ResultButton>
      : kind === "players" ? <PlayerResults {...props} query={query} players={players} actor={actor} choose={choose} />
      : <GameResults {...props} query={query} places={places} choose={choose} />}
  </Screen>;
}

function GameResults({ state, query, places: { matches, searching }, choose, ...props }: ScreenProps & { query: string; places: ReturnType<typeof usePlaceSearch>; choose: (target: string) => void }) {
  if (query.trim().length < 2) return <Recent {...props} state={state} choose={choose} players={false} empty={<EmptyState icon={<Search />} title="Search Roblox games" />} />;
  if (searching && !matches.length) return <ResultSkeletons icon="size-19 rounded-lg" />;
  if (!matches.length) return <EmptyState icon={<Search />} title="No games found" />;
  return <div className="grid gap-list @5xl:grid-cols-2 @[96rem]:grid-cols-3" aria-busy={searching}>
    {matches.map((place) => {
      const votes = place.upVotes + place.downVotes;
      const updated = updatedLabel(place.updated);
      return <ResultButton key={place.placeId} onClick={() => choose(place.placeId)}>
        <span className="grid size-19 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
          {place.iconUrl ? <img src={place.iconUrl} alt="" className="size-full object-cover" /> : <Gamepad2 className="size-6" />}
        </span>
        <span className="grid min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium" title={place.name}>{place.name}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">({place.placeId})</span>
            {place.placeId === state.settings.placeId && <Badge variant="outline">Current</Badge>}
          </span>
          {place.creatorName && <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="truncate">by {place.creatorName}</span>
            {place.creatorVerified && <><BadgeCheck className="size-3.5 shrink-0" aria-hidden="true" /><span className="sr-only">(verified)</span></>}
          </span>}
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
            <Stat icon={<Users />}>{compact.format(place.playerCount)} playing</Stat>
            {place.visits !== undefined && <Stat icon={<Eye />}>{compact.format(place.visits)} visits</Stat>}
            {place.favorites !== undefined && <Stat icon={<Heart />}>{compact.format(place.favorites)} favorites</Stat>}
            {votes > 0 && <Stat icon={<ThumbsUp />}>{Math.round((place.upVotes / votes) * 100)}% likes</Stat>}
            {updated && <Stat icon={<Clock />}>{updated}</Stat>}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1">
            {place.genre && <Badge variant="secondary">{place.genre}</Badge>}
            {place.maturity && <Badge variant="secondary">{capitalize(place.maturity)} maturity</Badge>}
            {place.price !== undefined && <Badge variant="secondary">{compact.format(place.price)} Robux</Badge>}
          </span>
        </span>
      </ResultButton>;
    })}
  </div>;
}

type PlayerProps = ScreenProps & { actor?: Account; choose: (target: string) => void };

function PlayerResults({ query, players: { matches, searching }, ...props }: PlayerProps & { query: string; players: ReturnType<typeof usePlayerSearch> }) {
  if (query.trim().replace(/^@/, "").trim().length < 2) return <Recent {...props} players empty={<EmptyState icon={<UserRound />} title="Search Roblox players" />} />;
  if (searching && !matches.length) return <ResultSkeletons icon="size-10 rounded-full" tonal />;
  if (!matches.length) return <EmptyState icon={<UserRound />} title="No players found" />;
  return <div className="grid gap-list @5xl:grid-cols-2 @[96rem]:grid-cols-3" aria-busy={searching}>
    {matches.map((player) => <PlayerRow key={`${props.actor?.id}:${player.id}`} {...props} player={player} />)}
  </div>;
}

/** Confirmation text for actions that are hard to undo. */
const confirmations: Partial<Record<SocialAction, { verb: string; message: (player: string, account: string) => string }>> = {
  unfriend: { verb: "Unfriend", message: (player, account) => `Removes ${player} from the friends of ${account} on Roblox.` },
  block: { verb: "Block", message: (player, account) => `Blocks ${player} for ${account} on Roblox, which also removes them as a friend.` },
};

const done: Record<SocialAction, string> = {
  requestFriend: "Friend request sent", acceptFriend: "Friend request accepted", declineFriend: "Friend request declined", unfriend: "Unfriended",
  follow: "Followed", unfollow: "Unfollowed", block: "Blocked", unblock: "Unblocked",
};

function PlayerRow({ state, notify, confirm, actor, choose, player }: PlayerProps & { player: PlayerMatch }) {
  const [relationship, setRelationship] = useState<Relationship | "loading" | "failed">();
  const [busy, setBusy] = useState<SocialAction>();
  const target = `@${player.id}`;
  const name = `@${player.name}`;
  const ready = actor && !actor.sessionExpired && actor.id !== player.id ? actor : undefined;
  const load = () => {
    if (!ready) return;
    setRelationship("loading");
    bridge.getRelationship(ready.id, player.id).then(setRelationship, () => setRelationship("failed"));
  };
  useEffect(load, [ready?.id, player.id]);
  const run = (action: SocialAction) => {
    if (!ready) return;
    const change = () => {
      setBusy(action);
      return bridge.changeRelationship(ready.id, player.id, action)
        .then(() => { notify(`${done[action]}: ${name}.`); load(); })
        .finally(() => setBusy(undefined));
    };
    const prompt = confirmations[action];
    if (prompt) confirm({ title: `${prompt.verb} ${name}?`, message: prompt.message(name, accountName(ready)), action: prompt.verb, danger: true, run: change });
    else void change().catch((error) => notify(failure(`The change didn't go through. Does retrying help?`, error)));
  };
  const known = typeof relationship === "object" ? relationship : undefined;
  const action = (label: string, social: SocialAction, icon: ReactNode, className?: string) =>
    <IconButton label={label} size="icon-sm" className={cn("text-muted-foreground", className)} disabled={busy !== undefined} onClick={() => run(social)}>{busy === social ? <Spinner /> : icon}</IconButton>;

  return <div className="flex items-center gap-3 rounded-xl bg-muted/50 p-3">
    <Tooltip>
      <TooltipTrigger render={<button type="button" aria-label={`Open the Roblox profile of ${name}`} onClick={() => void bridge.openExternal(`https://www.roblox.com/users/${player.id}/profile`)}
        className="group/avatar relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-background text-muted-foreground ring-1 ring-foreground/8 outline-none transition-shadow hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring" />}>
        {player.avatarUrl && state.settings.showAvatars ? <img src={player.avatarUrl} alt="" className="size-full object-cover" /> : <UserRound className="size-5" />}
        <span className="absolute inset-0 grid place-items-center bg-background/70 text-foreground opacity-0 transition-opacity motion-reduce:transition-none group-hover/avatar:opacity-100 group-focus-visible/avatar:opacity-100" aria-hidden="true"><ExternalLink className="size-4" /></span>
      </TooltipTrigger>
      <TooltipContent>Open profile</TooltipContent>
    </Tooltip>
    <button type="button" onClick={() => choose(target)} aria-label={`Set ${name} as the destination`}
      className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
      <span className="grid min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-sm font-medium" title={player.displayName}>{player.displayName}</span>
          {player.verified && <><BadgeCheck className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="sr-only">(verified)</span></>}
          {target === state.settings.placeId && <Badge variant="outline" className="ml-1">Current</Badge>}
        </span>
        <span className="truncate text-xs text-muted-foreground">{name}</span>
      </span>
    </button>
    <div className="flex shrink-0 items-center gap-1" role="group" aria-label={ready ? `Actions for ${name} as ${accountName(ready)}` : `Actions for ${name}`}>
      {ready && (relationship === "loading" || relationship === undefined ? <span className="flex gap-1" role="status" aria-label="Loading status">
        {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="size-7 rounded-lg" />)}
      </span>
        : relationship === "failed" ? <IconButton label="Status didn't load. Retry" size="icon-sm" className="text-muted-foreground" onClick={load}><RotateCcw /></IconButton>
        : known && <>
          {!known.blocked && <>
            {known.friend === "none" && action("Add friend", "requestFriend", <UserRoundPlus />)}
            {known.friend === "requestSent" && <IconButton label="Friend request sent" size="icon-sm" className="text-muted-foreground" disabled><UserRoundCheck /></IconButton>}
            {known.friend === "requestReceived" && <>
              {action("Accept friend request", "acceptFriend", <UserRoundCheck />)}
              {action("Decline friend request", "declineFriend", <UserRoundX />)}
            </>}
            {known.friend === "friends" && action("Unfriend", "unfriend", <UserRoundMinus />)}
            {known.following ? action("Unfollow", "unfollow", <BellOff />) : action("Follow", "follow", <BellPlus />)}
          </>}
          {known.blocked ? action("Unblock", "unblock", <ShieldOff />) : action("Block", "block", <Ban />, "hover:text-destructive")}
        </>)}
    </div>
  </div>;
}

function Stat({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1">{icon}{children}</span>;
}

function ResultSkeletons({ icon, tonal = false }: { icon: string; tonal?: boolean }) {
  return <div className="grid gap-list @5xl:grid-cols-2 @[96rem]:grid-cols-3" role="status" aria-label="Searching">
    {Array.from({ length: 6 }, (_, index) => <div key={index} className={cn("flex items-center gap-3 rounded-xl p-3", tonal ? "bg-muted/50" : "bg-card ring-1 ring-foreground/8")}>
      <Skeleton className={cn("shrink-0", icon)} />
      <span className="grid flex-1 gap-2"><Skeleton className="h-3.5 w-2/5" /><Skeleton className="h-3 w-3/5" /></span>
    </div>)}
  </div>;
}

/** The recent games or players, with the default first, shown before anything is typed. */
function Recent({ state, refresh, notify, choose, players, empty }: ScreenProps & { choose: (target: string) => void; players: boolean; empty: ReactNode }) {
  const recent = state.recentPlaces.filter((place) => (targetUserId(place.placeId) !== undefined) === players);
  if (!recent.length) return empty;
  const forget = (placeId: string) => bridge.forgetRecentPlace(placeId).then(refresh).catch((error) => notify(failure(`The place wasn't removed. Does retrying help?`, error)));
  return <section className="grid content-start gap-2" aria-labelledby="recent-heading">
    <h2 id="recent-heading" className="text-xs font-medium text-muted-foreground">Recent</h2>
    <div className="grid gap-list @5xl:grid-cols-2 @[96rem]:grid-cols-3">
      {recent.map((place) => {
        const label = placeLabel(state, place.placeId);
        return <div key={place.placeId} className={cn("flex items-center gap-1 rounded-xl pr-2", players ? "bg-muted/50" : "bg-card ring-1 ring-foreground/8")}>
          <button type="button" onClick={() => choose(place.placeId)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">
            <span className={cn("grid size-8 shrink-0 place-items-center bg-muted text-muted-foreground", players ? "rounded-full" : "rounded-lg")} aria-hidden="true">{players ? <UserRound className="size-4" /> : <Gamepad2 className="size-4" />}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={label}>{players ? label : place.name || "Unknown game"}</span>
            {place.placeId === state.settings.placeId && <Badge variant="outline">Current</Badge>}
            {!players && <span className="shrink-0 font-mono text-xs text-muted-foreground">{place.placeId}</span>}
          </button>
          <IconButton label={`Remove ${label} from recent places`} size="icon-sm" className="text-muted-foreground" onClick={() => void forget(place.placeId)}><X /></IconButton>
        </div>;
      })}
    </div>
  </section>;
}

function ResultButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className={cn("flex w-full items-center gap-3 rounded-xl bg-card p-3 text-left ring-1 ring-foreground/8 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring", lift)}>{children}</button>;
}
