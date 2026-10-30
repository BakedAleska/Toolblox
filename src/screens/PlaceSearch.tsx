import { ArrowLeft, BadgeCheck, Clock, Eye, Gamepad2, Heart, Search, ThumbsUp, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { parsePlaceId } from "@/logic";
import { EmptyState, IconButton, Screen, Spinner, usePlaceSearch, type ScreenProps } from "@/shared";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Updated Oct 28, 2026", or nothing when Roblox sent no valid date. */
const updatedLabel = (updated?: string) => {
  const date = updated ? new Date(updated) : undefined;
  return date && !Number.isNaN(date.getTime()) ? `Updated ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : undefined;
};

/** Finds a game by name and sets it as the default place. */
export function PlaceSearch({ state, navigate, patchSettings }: ScreenProps) {
  const [query, setQuery] = useState("");
  const { matches, searching } = usePlaceSearch(query);
  const typedId = parsePlaceId(query);
  const choose = (placeId: string) => { void patchSettings("placeId", placeId); navigate("/accounts"); };

  return <Screen title="Find a place" actions={<IconButton label="Back to accounts" onClick={() => navigate("/accounts")}><ArrowLeft /></IconButton>} toolbar={
    <form role="search" className="relative w-full" onSubmit={(event) => { event.preventDefault(); if (typedId) choose(typedId); else if (matches[0]) choose(matches[0].placeId); }}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input autoFocus type="search" name="place-search" value={query} placeholder="Game name, link, or place ID" aria-label="Search Roblox games" spellCheck={false} autoComplete="off"
        className="h-10 pl-9 text-base" onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape" && !query) navigate("/accounts"); }} />
    </form>}>
    {typedId ? <ResultButton onClick={() => choose(typedId)}>
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true"><Gamepad2 className="size-5" /></span>
      <span className="min-w-0 flex-1 text-sm font-medium">Use place <span className="font-mono">{typedId}</span></span>
    </ResultButton>
      : query.trim().length < 2 ? <EmptyState icon={<Search />} title="Search Roblox games" />
      : searching && !matches.length ? <div className="grid flex-1 place-items-center text-muted-foreground"><Spinner className="size-5" /></div>
      : !matches.length ? <EmptyState icon={<Search />} title="No games found" />
      : <div className="grid gap-list @5xl:grid-cols-2 @[96rem]:grid-cols-3" aria-busy={searching}>
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
                {place.placeId === state.settings.placeId && <Badge variant="outline">Default</Badge>}
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
      </div>}
  </Screen>;
}

function Stat({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1">{icon}{children}</span>;
}

function ResultButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-xl bg-card p-3 text-left ring-1 ring-foreground/8 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">{children}</button>;
}
