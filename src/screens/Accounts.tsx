import { ArrowDown, ArrowUp, ChevronDown, KeyRound, GripVertical, ListChecks, MapPin, MapPinOff, MoreHorizontal, Play, Plus, Search, Star, Trash2, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { bridge } from "@/bridge";
import { cn } from "@/lib/utils";
import { accountName, parsePlaceId, sortAccounts } from "@/logic";
import { AccountCard, EmptyState, IconButton, Panel, PlaceInput, Screen, Spinner, PresenceMark, placeLabel, presenceLabel, type ScreenProps, failure } from "@/shared";
import type { Account } from "@/types";
import { WidgetSlot } from "@/widgets/host";

/** Hides a row control until the row is hovered or focused. Touch screens always show it. */
const reveal = "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100";

/** Set before navigating to Accounts to open the first account's menu, where pinning lives. */
let openFirstMenu = false;
export const showAccountMenu = () => { openFirstMenu = true; };

export function Accounts({ state, refresh, navigate, notify, confirm, join, joining, signIn, askPlace, patchSettings }: ScreenProps) {
  const { settings } = state;
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [dragged, setDragged] = useState<number>();
  const [over, setOver] = useState<number>();
  const placeField = useRef<HTMLDivElement>(null);
  const [placeInvalid, setPlaceInvalid] = useState(false);
  const [placeText, setPlaceText] = useState(settings.placeId);
  const [menuFor, setMenuFor] = useState<number>();
  useEffect(() => setPlaceText(settings.placeId), [settings.placeId]);
  const [pendingOrder, setPendingOrder] = useState<Account[]>();
  const saved = useMemo(() => sortAccounts(state.accounts, settings.sortOrder), [state.accounts, settings.sortOrder]);
  const query = search.trim().toLowerCase();
  const sorted = pendingOrder ?? saved;
  useEffect(() => { if (openFirstMenu) { openFirstMenu = false; setMenuFor(sorted[0]?.id); } }, []);
  const visible = query ? sorted.filter(({ name, displayName, notes }) => [name, displayName, notes].some((text) => text.toLowerCase().includes(query))) : sorted;
  const reorderable = settings.sortOrder === "manual" && !query;

  const selecting = selected.size > 0;
  const toggleSelection = (id: number) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  /** Double-clicking a row starts a selection, and once one exists a click toggles a row. Clicks on the row's own controls don't count. */
  const rowClick = (event: MouseEvent<HTMLElement>, id: number) => {
    if ((event.target as HTMLElement).closest("button, a, input, textarea, [role=checkbox], [role=menuitem]")) return;
    if (event.type === "dblclick" ? selecting : !selecting) return;
    window.getSelection()?.removeAllRanges();
    toggleSelection(id);
  };
  const addAccount = async () => { setAdding(true); try { await bridge.beginRobloxLogin(); await refresh(); } catch (error) { notify(failure(`Sign-in didn't complete. Was the sign-in window closed?`, error)); } finally { setAdding(false); } };
  const persistOrder = (next: Account[]) => { setPendingOrder(next); return bridge.reorderAccounts(next.map(({ id }) => id)).then(refresh).catch((error) => notify(failure(`The order wasn't saved. Does refreshing help?`, error))).finally(() => setPendingOrder(undefined)); };
  const move = (id: number, direction: -1 | 1) => { const index = sorted.findIndex((account) => account.id === id); const target = index + direction; if (index < 0 || target < 0 || target >= sorted.length) return; const next = [...sorted];[next[index], next[target]] = [next[target], next[index]]; void persistOrder(next); };
  const drop = (targetId?: number) => { setDragged(undefined); setOver(undefined); if (dragged === undefined || targetId === undefined || dragged === targetId) return; const next = [...sorted]; const from = next.findIndex(({ id }) => id === dragged); const to = next.findIndex(({ id }) => id === targetId); next.splice(to, 0, next.splice(from, 1)[0]); void persistOrder(next); };
  const rowAt = (event: PointerEvent<Element>) => { const id = (document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-account-id]") as HTMLElement | null)?.dataset.accountId; return id ? Number(id) : undefined; };
  const forgetPlace = (placeId: string) => bridge.forgetRecentPlace(placeId).then(refresh).catch((error) => notify(failure(`The place wasn't removed. Does retrying help?`, error)));
  const setAccountPinned = (account: Account, pinned: boolean) => bridge.setAccountPinned(account.id, pinned).then(refresh).catch((error) => notify(failure(`The account wasn't ${pinned ? "pinned" : "unpinned"}. Does retrying help?`, error)));
  const setAccountPlace = (account: Account, placeId: string | null) => bridge.setAccountPlace(account.id, placeId).then(refresh).catch((error) => notify(failure(`The place wasn't saved. Does retrying help?`, error)));
  /** Saves the typed default place. Text that isn't a valid place stays in the field, marked invalid, and the saved place is kept. */
  const savePlace = async (text: string) => {
    const value = text.trim();
    setPlaceInvalid(false);
    if (!value) { if (settings.placeId) void patchSettings("placeId", ""); return; }
    const placeId = parsePlaceId(value);
    if (!placeId) { setPlaceInvalid(true); notify("No place ID found. Is it a Roblox game link or place ID?"); return; }
    if (placeId !== settings.placeId && !await bridge.placeExists(placeId).catch(() => true)) {
      setPlaceInvalid(true);
      notify(`Place ${placeId} doesn't exist. Is the ID correct?`);
      return;
    }
    setPlaceText(placeId);
    if (placeId !== settings.placeId) void patchSettings("placeId", placeId);
  };
  const placeName = settings.placeId && placeText === settings.placeId && !placeInvalid ? state.recentPlaces.find((place) => place.placeId === settings.placeId)?.name : undefined;

  return <Screen title="Accounts" toolbar={<>
    <WidgetSlot name="accounts.toolbar" props={{}} />
    <div ref={placeField} className="relative min-w-40 flex-1 basis-0">
      <MapPin className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <PlaceInput value={placeText} placeName={placeName} inset="pr-8 pl-8" placeholder="Default place" aria-label="Default place" aria-describedby="place-hint" aria-invalid={placeInvalid || undefined}
        change={(value) => { setPlaceText(value); setPlaceInvalid(false); }} pick={(place) => void savePlace(place.placeId)}
        onDoubleClick={() => navigate("/accounts/places")}
        onBlur={(event) => void savePlace(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      <span id="place-hint" className="sr-only">{settings.placeId ? `Joins ${placeLabel(state, settings.placeId)} unless an account has its own place.` : "Accepts a game name, Roblox game link, or place ID."} Double-click to open game search.</span>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="absolute top-1/2 right-1 -translate-y-1/2" aria-label="Place options" />}><ChevronDown /></DropdownMenuTrigger>
        <DropdownMenuContent anchor={placeField} align="start" className="min-w-0">
          <DropdownMenuItem onClick={() => navigate("/accounts/places")}><Search />Search games…</DropdownMenuItem>
          {state.recentPlaces.length > 0 && <><DropdownMenuSeparator /><DropdownMenuGroup>
            <DropdownMenuLabel>Recent places</DropdownMenuLabel>
            {state.recentPlaces.map((place) => <DropdownMenuItem key={place.placeId} className="pr-1" onClick={() => void patchSettings("placeId", place.placeId)}
              onKeyDown={(event) => { if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); void forgetPlace(place.placeId); } }}>
              <span className="min-w-0 flex-1 truncate" title={place.name}>{place.name || "Unknown game"}</span>
              <span className="font-mono text-xs text-muted-foreground">{place.placeId}</span>
              <Button variant="ghost" size="icon-xs" tabIndex={-1} aria-label={`Remove ${place.name || place.placeId} from recent places`} title="Remove (Delete)"
                onClick={(event) => { event.stopPropagation(); event.preventDefault(); void forgetPlace(place.placeId); }}><X /></Button>
            </DropdownMenuItem>)}
          </DropdownMenuGroup></>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <label className="relative min-w-40 flex-1 basis-0">
      <span className="sr-only">Search accounts</span>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input type="search" name="search" value={search} placeholder="Search" spellCheck={false} className="pl-8" onChange={(event) => setSearch(event.target.value)} />
    </label>
    <Button onClick={() => void addAccount()} disabled={adding}>{adding ? <Spinner /> : <Plus />}Add</Button>
  </>}>
    {selecting && <Panel className="flex animate-in items-center gap-1 py-2 pr-2 pl-3 fade-in-0 slide-in-from-top-1">
      <span className="mr-auto text-sm font-medium" aria-live="polite">{selected.size} selected</span>
      {selected.size < visible.length && <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(visible.map(({ id }) => id)))}>Select all</Button>}
      <Button size="sm" disabled={joining.length > 0} onClick={() => join([...selected])}>{joining.length > 0 ? <Spinner /> : <Play />}Join selected</Button>
      <IconButton label="Clear selection" size="icon-sm" onClick={() => setSelected(new Set())}><X /></IconButton>
    </Panel>}

    {state.accounts.length === 0 ? <EmptyState icon={<Users />} title="No accounts" text="Accounts sign in through the official Roblox page. Passwords never reach Toolblox." action={<Button onClick={() => void addAccount()} disabled={adding}><Plus />Add account</Button>} />
      : visible.length === 0 ? <EmptyState icon={<Search />} title="No results" text="No account matches this search." />
        : <div className="grid content-start gap-list @5xl:grid-cols-2 @[96rem]:grid-cols-3">{visible.map((account, index) => <AccountCard key={account.id} data-account-id={account.id} account={account}
          showAvatar={settings.showAvatars} avatarClassName={settings.compactMode ? "size-8" : "size-10"}
          onClick={(event) => rowClick(event, account.id)} onDoubleClick={(event) => rowClick(event, account.id)}
          className={cn("group transition-opacity", selecting && "cursor-pointer", settings.compactMode && "py-2", dragged === account.id && "opacity-50", ((over === account.id && dragged !== account.id) || selected.has(account.id)) && "ring-2 ring-ring")}
          leading={<>
            {reorderable && <GripVertical className="size-4 shrink-0 cursor-grab touch-none text-muted-foreground/50 group-hover:text-muted-foreground active:cursor-grabbing" aria-hidden="true"
              onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDragged(account.id); }}
              onPointerMove={(event) => { if (dragged !== undefined) setOver(rowAt(event)); }}
              onPointerUp={(event) => drop(rowAt(event))} onPointerCancel={() => drop()} />}
            {selecting && <Checkbox checked={selected.has(account.id)} onCheckedChange={() => toggleSelection(account.id)} aria-label={`Select ${accountName(account)}`} />}
          </>}
          inline={<>
            {account.displayName && account.displayName !== account.name && <span className="truncate text-xs text-muted-foreground">@{account.name}</span>}
            {account.placeId && <Badge variant="outline" title={`Place override: ${placeLabel(state, account.placeId)} (${account.placeId})`} className="min-w-0 shrink text-muted-foreground"><MapPin /><span className="truncate">{placeLabel(state, account.placeId)}</span></Badge>}
            {presenceLabel(account) && <Badge variant="secondary" title={presenceLabel(account)} className="min-w-0 shrink"><PresenceMark account={account} small /><span className="truncate">{presenceLabel(account)}</span></Badge>}
          </>}
          actions={<>
            <DropdownMenu open={menuFor === account.id} onOpenChange={(open) => setMenuFor(open ? account.id : undefined)}>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className={cn("text-muted-foreground data-popup-open:opacity-100", reveal)} aria-label={`More actions for ${accountName(account)}`} />}><MoreHorizontal /></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuItem onClick={() => toggleSelection(account.id)}><ListChecks />{selected.has(account.id) ? "Deselect" : "Select"}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void setAccountPinned(account, !account.pinned)}><Star className={cn(account.pinned && "fill-current")} />{account.pinned ? "Unpin from dashboard" : "Pin to dashboard"}</DropdownMenuItem>
                <DropdownMenuSeparator />
                {reorderable && <>
                  <DropdownMenuItem disabled={index === 0} onClick={() => move(account.id, -1)}><ArrowUp />Move up</DropdownMenuItem>
                  <DropdownMenuItem disabled={index === visible.length - 1} onClick={() => move(account.id, 1)}><ArrowDown />Move down</DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>}
                <DropdownMenuItem onClick={() => askPlace({
                  title: `Place for ${accountName(account)}`, description: "Overrides the default place for this account.", action: "Save",
                  run: (placeId) => setAccountPlace(account, placeId)
                })}><MapPin />{account.placeId ? "Change place…" : "Set place…"}</DropdownMenuItem>
                {account.placeId && <DropdownMenuItem onClick={() => void setAccountPlace(account, null)}><MapPinOff />Use default place</DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => confirm({ title: `Remove ${accountName(account)}?`, message: "Removes the account and its saved session from this device.", action: "Remove", danger: true, run: async () => { await bridge.removeAccount(account.id); await refresh(); } })}><Trash2 />Remove</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {account.sessionExpired
              ? <Button variant="outline" size="sm" onClick={() => void signIn(account.id)} aria-label={`Sign in again as ${accountName(account)}`}><KeyRound />Sign in again</Button>
              : <Button variant="outline" size="sm" disabled={joining.includes(account.id)} onClick={() => join([account.id])} aria-label={`Join as ${accountName(account)}`}>{joining.includes(account.id) ? <Spinner /> : <Play />}Join</Button>}
          </>}>
          <WidgetSlot name="accounts.row" props={{ account }} wrap={(children) => <div className="mt-1 flex flex-wrap items-center gap-2">{children}</div>} />
          {!settings.compactMode && <textarea rows={1} name="notes" defaultValue={account.notes} placeholder="Add a note" aria-label={`Notes for ${accountName(account)}`}
            className="-mx-1 mt-0.5 block max-h-16 w-full resize-none rounded-lg bg-transparent px-1 text-xs text-muted-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
            onBlur={(event) => { if (event.target.value !== account.notes) void bridge.updateAccountNotes(account.id, event.target.value).then(refresh).catch((error) => notify(failure(`The note wasn't saved. Does retrying help?`, error))); }} />}
        </AccountCard>)}</div>}
    <span className="sr-only" aria-live="polite">{adding ? "Roblox sign-in window open." : ""}</span>
  </Screen>;
}
