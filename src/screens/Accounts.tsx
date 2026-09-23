import { ArrowDown, ArrowUp, ChevronDown, GripVertical, ListChecks, MapPin, MapPinOff, MoreHorizontal, Play, Plus, Search, Trash2, Users, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { bridge } from "@/bridge";
import { cn } from "@/lib/utils";
import { accountName, parsePlaceId, sortAccounts } from "@/logic";
import { Avatar, EmptyState, IconButton, Panel, Screen, Spinner, placeLabel, presenceLabel, type ScreenProps } from "@/shared";
import type { Account } from "@/types";
import { WidgetSlot } from "@/widgets/host";

export function Accounts({ state, refresh, notify, confirm, join, askPlace, patchSettings }: ScreenProps) {
  const { settings } = state;
  const [query, setQuery] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [dragged, setDragged] = useState<number>();
  const placeField = useRef<HTMLLabelElement>(null);
  const sorted = useMemo(() => sortAccounts(state.accounts, settings.sortOrder), [state.accounts, settings.sortOrder]);
  const visible = sorted.filter((account) => `${account.name} ${account.displayName} ${account.notes}`.toLowerCase().includes(query.trim().toLowerCase()));
  const reorderable = settings.sortOrder === "manual" && !query;

  const toggleSelection = (id: number) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const addAccount = async () => { setAdding(true); try { await bridge.beginRobloxLogin(); await refresh(); } catch (error) { notify(`Sign-in didn't complete. Was the sign-in window closed? (${String(error)})`); } finally { setAdding(false); } };
  const persistOrder = async (next: Account[]) => { await bridge.reorderAccounts(next.map(({ id }) => id)); await refresh(); };
  const move = (id: number, direction: -1 | 1) => { const index = sorted.findIndex((account) => account.id === id); const target = index + direction; if (index < 0 || target < 0 || target >= sorted.length) return; const next = [...sorted]; [next[index], next[target]] = [next[target], next[index]]; void persistOrder(next); };
  const drop = (targetId: number) => { if (!dragged || dragged === targetId) return; const next = [...sorted]; const from = next.findIndex(({ id }) => id === dragged); const to = next.findIndex(({ id }) => id === targetId); next.splice(to, 0, next.splice(from, 1)[0]); setDragged(undefined); void persistOrder(next); };
  const setAccountPlace = (account: Account, placeId: string | null) => bridge.setAccountPlace(account.id, placeId).then(refresh).catch((error) => notify(`The place wasn't saved. Does retrying help? (${String(error)})`));
  const savePlace = async (input: HTMLInputElement) => {
    const value = input.value.trim();
    if (!value) { if (settings.placeId) void patchSettings("placeId", ""); return; }
    const placeId = parsePlaceId(value);
    if (!placeId) { input.value = settings.placeId; notify("No place ID found. Is the link complete?"); return; }
    input.value = placeId;
    if (placeId === settings.placeId) return;
    if (!await bridge.placeExists(placeId).catch(() => true)) {
      input.value = "";
      if (settings.placeId) void patchSettings("placeId", "");
      notify(`Place ${placeId} doesn't exist. Is the ID correct?`);
      return;
    }
    void patchSettings("placeId", placeId);
  };

  return <Screen title="Accounts" actions={<>
    <WidgetSlot name="accounts.toolbar" props={{}} />
    <label ref={placeField} className="relative min-w-0 flex-1 basis-0" title={settings.placeId ? `Default place: ${placeLabel(state, settings.placeId)}` : "No default place set"}>
      <span className="sr-only">Default place ID or Roblox game link</span>
      <MapPin className={cn("pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2", settings.placeId ? "text-muted-foreground" : "text-destructive")} aria-hidden="true" />
      <Input key={settings.placeId} defaultValue={settings.placeId} placeholder="Place ID or link" aria-describedby="place-hint"
        className={cn("pl-8 font-mono placeholder:font-sans", state.recentPlaces.length > 0 && "pr-8", !settings.placeId && "border-destructive/60 placeholder:text-destructive/80")}
        onBlur={(event) => void savePlace(event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      <span id="place-hint" className="sr-only">{settings.placeId ? `Default place: ${placeLabel(state, settings.placeId)}.` : "No default place set."}</span>
      {state.recentPlaces.length > 0 && <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="absolute top-1/2 right-1 -translate-y-1/2" aria-label="Recent places" />}><ChevronDown /></DropdownMenuTrigger>
        <DropdownMenuContent anchor={placeField} align="start" className="min-w-0">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Recent places</DropdownMenuLabel>
            {state.recentPlaces.map((place) => <DropdownMenuItem key={place.placeId} onClick={() => void patchSettings("placeId", place.placeId)}>
              <span className="min-w-0 flex-1 truncate">{place.name || "Unknown game"}</span>
              <span className="font-mono text-xs text-muted-foreground">{place.placeId}</span>
            </DropdownMenuItem>)}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>}
    </label>
    <label className="relative min-w-0 flex-1 basis-0">
      <span className="sr-only">Search accounts</span>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
    </label>
    <IconButton label={selectMode ? "Exit selection" : "Select accounts"} variant={selectMode ? "secondary" : "ghost"} onClick={() => { setSelectMode((value) => !value); setSelected(new Set()); }}>{selectMode ? <X /> : <ListChecks />}</IconButton>
    <Button onClick={() => void addAccount()} disabled={adding}>{adding ? <Spinner /> : <Plus />}Add</Button>
  </>}>
    {selectMode && <Panel className="flex animate-in items-center gap-1 py-1.5 pr-1.5 pl-3 fade-in-0 slide-in-from-top-1">
      <span className="mr-auto text-sm font-medium" aria-live="polite">{selected.size} selected</span>
      <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(visible.map(({ id }) => id)))}>Select all</Button>
      <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
      <Button size="sm" disabled={!selected.size} onClick={() => join([...selected])}><Play />Join selected</Button>
    </Panel>}

    {state.accounts.length === 0 ? <EmptyState icon={<Users />} title="No accounts" text="Accounts are added through the official Roblox sign-in page. Passwords are never sent to Toolblox." action={<Button onClick={() => void addAccount()} disabled={adding}><Plus />Add account</Button>} />
      : visible.length === 0 ? <EmptyState icon={<Search />} title="No results" text="No account matches this search." />
      : <div className="flex flex-col gap-2">{visible.map((account, index) => <Panel key={account.id}
          className={cn("group flex items-center gap-3 px-3 transition-opacity", settings.compactMode ? "py-1.5" : "py-2.5", dragged === account.id && "opacity-50")}
          draggable={reorderable} onDragStart={() => setDragged(account.id)} onDragEnd={() => setDragged(undefined)} onDragOver={(event) => event.preventDefault()} onDrop={() => drop(account.id)}>
        {reorderable && <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground/50 group-hover:text-muted-foreground" aria-hidden="true" />}
        {selectMode && <Checkbox checked={selected.has(account.id)} onCheckedChange={() => toggleSelection(account.id)} aria-label={`Select ${accountName(account)}`} />}
        {settings.showAvatars && <Avatar account={account} className={settings.compactMode ? "size-8" : "size-10"} />}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{accountName(account)}</span>
            {account.displayName && account.displayName !== account.name && <span className="truncate text-xs text-muted-foreground">@{account.name}</span>}
            {account.placeId && <Badge variant="outline" title={`Place override: ${placeLabel(state, account.placeId)} (${account.placeId})`} className="min-w-0 shrink text-muted-foreground"><MapPin /><span className="truncate">{placeLabel(state, account.placeId)}</span></Badge>}
            {presenceLabel(account) && <Badge variant="secondary" title={presenceLabel(account)} className={cn("min-w-0 shrink", account.presence === "playing" ? "text-success" : "text-destructive")}><span className="truncate">{presenceLabel(account)}</span></Badge>}
          </div>
          <WidgetSlot name="accounts.row" props={{ account }} wrap={(children) => <div className="mt-1 flex flex-wrap items-center gap-1.5">{children}</div>} />
          {!settings.compactMode && <textarea rows={1} defaultValue={account.notes} placeholder="Add a note" aria-label={`Notes for ${accountName(account)}`}
            className="-mx-1 mt-0.5 block max-h-16 w-full resize-none rounded-md bg-transparent px-1 text-xs text-muted-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground/60 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50"
            onBlur={(event) => { if (event.target.value !== account.notes) void bridge.updateAccountNotes(account.id, event.target.value).then(refresh).catch((error) => notify(`The note wasn't saved. Does retrying help? (${String(error)})`)); }} />}
        </div>
        <Button variant="outline" size="sm" onClick={() => join([account.id])} aria-label={`Join as ${accountName(account)}`}><Play />Join</Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${accountName(account)}`} />}><MoreHorizontal /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            {reorderable && <>
              <DropdownMenuItem disabled={index === 0} onClick={() => move(account.id, -1)}><ArrowUp />Move up</DropdownMenuItem>
              <DropdownMenuItem disabled={index === visible.length - 1} onClick={() => move(account.id, 1)}><ArrowDown />Move down</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>}
            <DropdownMenuItem onClick={() => askPlace({ title: `Place for ${accountName(account)}`, description: "Overrides the default place for this account.", action: "Save",
              run: (placeId) => setAccountPlace(account, placeId) })}><MapPin />{account.placeId ? "Change place…" : "Set place…"}</DropdownMenuItem>
            {account.placeId && <DropdownMenuItem onClick={() => void setAccountPlace(account, null)}><MapPinOff />Use default place</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => confirm({ title: `Remove ${accountName(account)}?`, message: "Removes the account and its saved session from this device.", action: "Remove", danger: true, run: async () => { await bridge.removeAccount(account.id); await refresh(); } })}><Trash2 />Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Panel>)}</div>}
    <span className="sr-only" aria-live="polite">{adding ? "Roblox sign-in window open." : ""}</span>
  </Screen>;
}
