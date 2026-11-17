import { ArrowDown, FolderInput, FolderPlus, ArrowUp, Copy, ExternalLink, KeyRound, GripVertical, ListChecks, MapPin, MapPinOff, MoreHorizontal, NotebookPen, Play, Repeat1, Plus, Search, Star, Timer, Trash2, Undo2, UserRound, Users, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type MouseEvent, type PointerEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { bridge } from "@/bridge";
import { cn } from "@/lib/utils";
import { accountName, matchAccount, relativeTime, sortAccounts, targetUserId } from "@/logic";
import { AccountCard, EmptyState, Hint, IconButton, Panel, Screen, Spinner, PresenceMark, placeLabel, presenceLabel, presenceShort, type ScreenProps, failure } from "@/shared";
import type { Account } from "@/types";
import { WidgetSlot } from "@/widgets/host";
import { destinationPeek, searchDestinationFor, searchGroupDestinationFor } from "@/screens/PlaceSearch";
import { GroupCard, editGroup, matchGroup } from "@/screens/Groups";
import type { AccountGroup } from "@/types";

/** Fades a row control in while the row is hovered or focused. Touch screens always show it. */
const reveal = "opacity-0 transition-opacity duration-200 motion-reduce:transition-none group-hover:opacity-100 group-has-focus-visible:opacity-100 group-has-data-popup-open:opacity-100 pointer-coarse:opacity-100";

/** Set before navigating to Accounts to open the first account's menu, where pinning lives. */
let openFirstMenu = false;
export const showAccountMenu = () => { openFirstMenu = true; };

export function Accounts({ state, refresh, navigate, notify, done, confirm, join, joining, joinProgress, cancelJoin, nextJoin, setNextJoin, signIn, patchSettings }: ScreenProps) {
  /** The pin's label: the one-time destination when set, otherwise the saved default. */
  const pinLabel = nextJoin.default ? `Next join: ${nextJoin.default.name}` : state.settings.placeId ? placeLabel(state, state.settings.placeId) : undefined;
  const { settings } = state;
  const [search, setSearch] = useState("");
  useEffect(() => {
    const open = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); document.querySelector<HTMLInputElement>("input[name=search]")?.focus(); } };
    window.addEventListener("keydown", open);
    return () => window.removeEventListener("keydown", open);
  }, []);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [dragged, setDragged] = useState<number>();
  const [over, setOver] = useState<number>();
  const [menuFor, setMenuFor] = useState<number>();
  /** The row whose actions are rendered: the open one, kept briefly after closing so it slides shut. */
  const [actionsFor, setActionsFor] = useState<number>();
  useEffect(() => {
    if (menuFor !== undefined) { setActionsFor(menuFor); return; }
    const timer = window.setTimeout(() => setActionsFor(undefined), 200);
    return () => window.clearTimeout(timer);
  }, [menuFor]);
  const [pendingOrder, setPendingOrder] = useState<Account[]>();
  /** Pinned accounts come first, each group in the chosen order. */
  /** Pin changes show at once and are saved in the background. Each is dropped once saved. */
  const [pinOverrides, setPinOverrides] = useState<Record<number, boolean>>({});
  const saved = useMemo(() => {
    const accounts = state.accounts.map((account) => account.id in pinOverrides ? { ...account, pinned: pinOverrides[account.id] } : account);
    const ordered = sortAccounts(accounts, settings.sortOrder);
    return [...ordered.filter(({ pinned }) => pinned), ...ordered.filter(({ pinned }) => !pinned)];
  }, [state.accounts, settings.sortOrder, pinOverrides]);
  const query = search.trim();
  const sorted = pendingOrder ?? saved;
  useEffect(() => { if (openFirstMenu) { openFirstMenu = false; setMenuFor(sorted[0]?.id); } }, []);
  /** Open row actions close on Escape or a press outside them. */
  useEffect(() => {
    if (menuFor === undefined) return;
    const outside = (event: globalThis.PointerEvent) => { if (!(event.target as Element).closest?.(`[data-account-actions="${menuFor}"], [data-actions-toggle="${menuFor}"], [role=menu], [role=dialog], [role=alertdialog]`)) setMenuFor(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuFor(undefined); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
  }, [menuFor]);
  const visible = query ? sorted.filter((account) => matchAccount(account, query)) : sorted;
  const reorderable = settings.sortOrder === "manual" && !query;

  /** Selection starts from the header button or a double-click, and stays on until stopped. */
  const [selectMode, setSelectMode] = useState(false);
  const selecting = selectMode || selected.size > 0;
  /** The join delay as typed. It's saved as whole seconds from 0 to 60 when the field is left. */
  const [delayText, setDelayText] = useState(String(settings.joinDelaySeconds));
  /** The delay box stays collapsed behind its timer button until opened. */
  const [delayOpen, setDelayOpen] = useState(false);
  useEffect(() => setDelayText(String(settings.joinDelaySeconds)), [settings.joinDelaySeconds]);
  const saveDelay = () => {
    const seconds = Number(delayText);
    if (delayText.trim() === "" || !Number.isFinite(seconds)) { setDelayText(String(settings.joinDelaySeconds)); return; }
    const delay = Math.min(60, Math.max(0, Math.round(seconds)));
    setDelayText(String(delay));
    if (delay !== settings.joinDelaySeconds) void patchSettings("joinDelaySeconds", delay);
  };
  /** Selected accounts whose join is in progress, which the selection bar can cancel together. */
  const joiningSelected = [...selected].filter((id) => joining.includes(id));
  const stopSelecting = () => { setSelected(new Set()); setSelectMode(false); };
  const groups = settings.groups ?? [];
  const shownGroups = [...groups.filter(({ pinned }) => pinned), ...groups.filter(({ pinned }) => !pinned)].filter((group) => !query || matchGroup(state, group, query));
  const openGroup = (group: AccountGroup) => { editGroup(group); navigate("/accounts/group"); };
  const newGroup = (accountIds: number[]) => openGroup({ id: crypto.randomUUID(), name: "", accountIds, pinned: false, notes: "" });
  const saveGroup = (group: AccountGroup) => {
    const exists = groups.some(({ id }) => id === group.id);
    void patchSettings("groups", exists ? groups.map((current) => current.id === group.id ? group : current) : [...groups, group]);
  };
  /** Shows the destination beside the pin for a moment after one is saved. */
  const [peeking, setPeeking] = useState(false);
  useEffect(() => {
    if (!destinationPeek.pending) return;
    setPeeking(true);
    const timer = window.setTimeout(() => { destinationPeek.pending = false; setPeeking(false); }, 1800);
    return () => window.clearTimeout(timer);
  }, []);
  /** Pinned accounts get their own heading when both groups are shown. */
  /** Pinned groups sit with pinned accounts. Other groups come last, under their own heading. */
  const pinnedGroups = shownGroups.filter(({ pinned }) => pinned);
  const otherGroups = shownGroups.filter(({ pinned }) => !pinned);
  const grouped = (pinnedGroups.length > 0 || visible.some(({ pinned }) => pinned)) && (visible.some(({ pinned }) => !pinned) || otherGroups.length > 0);
  const groupCard = (group: AccountGroup) => <GroupCard key={group.id} state={state} join={join} joining={joining} cancelJoin={cancelJoin} group={group}
          className={settings.compactMode ? "py-2" : undefined} patchGroup={saveGroup}
          edit={() => openGroup(group)}
          selectMembers={() => { setSelected(new Set(group.accountIds.filter((id) => state.accounts.some((account) => account.id === id)))); setSelectMode(true); }}
          setDestination={() => { searchGroupDestinationFor(group.id); navigate("/accounts/places"); }}
          remove={() => confirm({ title: `Delete ${group.name}?`, message: "Deletes the group. Its accounts stay on this device.", action: "Delete", danger: true,
            run: async () => { await patchSettings("groups", groups.filter(({ id }) => id !== group.id)); done(`Deleted ${group.name}.`); } })} />;
  const toggleSelection = (id: number) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  /** Double-clicking a row starts a selection, and once one exists a click toggles a row. Clicks on the row's own controls don't count. */
  const rowClick = (event: MouseEvent<HTMLElement>, id: number) => {
    if ((event.target as HTMLElement).closest("button, a, input, textarea, [role=checkbox], [role=menuitem]")) return;
    if (event.type === "dblclick" ? selecting : !selecting) return;
    window.getSelection()?.removeAllRanges();
    toggleSelection(id);
  };
  const addAccount = async () => { setAdding(true); try { const account = await bridge.beginRobloxLogin(); done(`Added ${accountName(account)}.`); await refresh(); } catch (error) { notify(failure(`Sign-in didn't complete. Was the sign-in window closed?`, error)); } finally { setAdding(false); } };
  const persistOrder = (next: Account[]) => { setPendingOrder(next); return bridge.reorderAccounts(next.map(({ id }) => id)).then(refresh).catch((error) => notify(failure(`The order wasn't saved. Does refreshing help?`, error))).finally(() => setPendingOrder(undefined)); };
  const move = (id: number, direction: -1 | 1) => { const index = sorted.findIndex((account) => account.id === id); const target = index + direction; if (index < 0 || target < 0 || target >= sorted.length) return; const next = [...sorted];[next[index], next[target]] = [next[target], next[index]]; void persistOrder(next); };
  const drop = (targetId?: number) => { setDragged(undefined); setOver(undefined); if (dragged === undefined || targetId === undefined || dragged === targetId) return; const next = [...sorted]; const from = next.findIndex(({ id }) => id === dragged); const to = next.findIndex(({ id }) => id === targetId); next.splice(to, 0, next.splice(from, 1)[0]); void persistOrder(next); };
  const rowAt = (event: PointerEvent<Element>) => { const id = (document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-account-id]") as HTMLElement | null)?.dataset.accountId; return id ? Number(id) : undefined; };
  const setAccountPinned = (account: Account, pinned: boolean) => {
    setPinOverrides((current) => ({ ...current, [account.id]: pinned }));
    const settle = () => setPinOverrides(({ [account.id]: _, ...rest }) => rest);
    return bridge.setAccountPinned(account.id, pinned).then(() => { done(`${pinned ? "Pinned" : "Unpinned"} ${accountName(account)} ${pinned ? "to" : "from"} the dashboard.`); return refresh(); }).finally(settle).catch((error) => notify(failure(`The account wasn't ${pinned ? "pinned" : "unpinned"}. Does retrying help?`, error)));
  };
  const setAccountPlace = (account: Account, placeId: string | null) => bridge.setAccountPlace(account.id, placeId).then(() => { done(`${accountName(account)} uses the default destination.`); return refresh(); }).catch((error) => notify(failure(`The place wasn't saved. Does retrying help?`, error)));

  return <Screen title="Accounts" tools={<><IconButton label="New group" className="text-muted-foreground" onClick={() => newGroup([])}><FolderPlus /></IconButton><IconButton label={selecting ? "Stop selecting" : "Select accounts"} className="text-muted-foreground" aria-pressed={selecting}
    onClick={() => { if (selecting) stopSelecting(); else setSelectMode(true); }}><ListChecks /></IconButton></>} toolbar={<>
    <WidgetSlot name="accounts.toolbar" props={{}} />
    <label className="relative min-w-40 flex-1 basis-0">
      <span className="sr-only">Search accounts by name or note</span>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input type="search" name="search" value={search} placeholder="Search…" spellCheck={false} aria-describedby={query ? "search-count" : undefined}
        className="pr-24 pl-8 [&::-webkit-search-cancel-button]:hidden" onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape" && search) { event.preventDefault(); setSearch(""); } }} />
      {query && <span className="absolute inset-y-0 right-1 flex items-center gap-2">
        <span id="search-count" className="text-xs text-muted-foreground tabular-nums" aria-live="polite">{visible.length} of {sorted.length}</span>
        <IconButton type="button" label="Clear search (Esc)" size="icon-xs" className="text-muted-foreground" onClick={() => setSearch("")}><X /></IconButton>
      </span>}
    </label>
    <Button variant="outline" className="group/pin gap-0 px-2" onClick={() => navigate("/accounts/places")} title={pinLabel}
      aria-label={nextJoin.default ? `${pinLabel}. Change destination` : settings.placeId ? `${targetUserId(settings.placeId) === undefined ? "Joins" : "Follows"} ${pinLabel}. Change destination` : "Set a destination"}>
      {nextJoin.default ? <Repeat1 /> : targetUserId(settings.placeId) === undefined ? <MapPin /> : <UserRound />}
      <span aria-hidden="true" className={cn("grid grid-cols-[0fr] opacity-0 transition-[grid-template-columns,margin,opacity] duration-300 ease-out motion-reduce:transition-none group-hover/pin:ml-1.5 group-hover/pin:grid-cols-[1fr] group-hover/pin:opacity-100 group-focus-visible/pin:ml-1.5 group-focus-visible/pin:grid-cols-[1fr] group-focus-visible/pin:opacity-100", peeking && "ml-1.5 grid-cols-[1fr] opacity-100")}>
        <span className="min-w-0 overflow-hidden">
          <span className="block max-w-56 truncate">{pinLabel ?? "Set a destination"}</span>
        </span>
      </span>
    </Button>
    {nextJoin.default && <IconButton label="Clear the next join destination" className="-ml-1 text-muted-foreground" onClick={() => setNextJoin("default")}><X /></IconButton>}
    <Button onClick={() => void addAccount()} disabled={adding}>{adding ? <Spinner /> : <Plus />}Add</Button>
  </>}>
    {selecting && <Panel className="flex animate-in items-center gap-1 py-2 pr-2 pl-3 fade-in-0 slide-in-from-top-1">
      <span className="mr-auto text-sm font-medium" aria-live="polite">{selected.size ? `${selected.size} selected` : "Select accounts to join"}</span>
      {selected.size < visible.length && <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(visible.map(({ id }) => id)))}>Select all</Button>}
      {joiningSelected.length
        ? <Button size="sm" variant="outline" onClick={() => cancelJoin(joiningSelected)} aria-label={`Cancel ${joiningSelected.length === 1 ? "the join" : `${joiningSelected.length} joins`}`}>
          <Spinner />{joinProgress && joinProgress.total > 1 ? `Joining ${joinProgress.done} of ${joinProgress.total}` : "Joining"} · Cancel
        </Button>
        : <Button size="sm" disabled={joining.length > 0 || selected.size === 0} onClick={() => join([...selected])}><Play />Join selected</Button>}
      <IconButton label="Group the selected accounts" size="icon-sm" className="text-muted-foreground" disabled={selected.size === 0} onClick={() => newGroup([...selected])}><FolderPlus /></IconButton>
      <div className="flex items-center">
        <IconButton label={`Join delay: ${settings.joinDelaySeconds} s between accounts`} size="icon-sm" className="text-muted-foreground" aria-expanded={delayOpen}
          onPointerDown={(event) => { if (delayOpen) event.preventDefault(); }} onClick={() => { if (delayOpen) { saveDelay(); setDelayOpen(false); } else setDelayOpen(true); }}><Timer /></IconButton>
        <span className={cn("grid grid-cols-[0fr] transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none", delayOpen ? "grid-cols-[1fr] opacity-100" : "opacity-0")}>
          <span className="min-w-0 overflow-hidden p-0.5">
            <label className="relative flex items-center" style={{ width: `calc(${Math.max(1, delayText.length)}ch + 4rem)` }}>
              {delayOpen && <Input autoFocus type="number" inputMode="numeric" min={0} max={60} step={1} value={delayText} aria-label="Seconds between accounts when joining"
                className="h-7 pr-2 pl-2.5 text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                onChange={(event) => setDelayText(event.target.value)} onBlur={() => { saveDelay(); setDelayOpen(false); }}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); else if (event.key === "Escape") { event.preventDefault(); setDelayText(String(settings.joinDelaySeconds)); setDelayOpen(false); } }} />}
              <span className="pointer-events-none absolute inset-0 flex items-center border border-transparent px-2.5 text-xs whitespace-pre" aria-hidden="true">
                <span className="invisible tabular-nums">{delayText}</span><span className="text-muted-foreground"> s delay</span>
              </span>
            </label>
          </span>
        </span>
      </div>
      <IconButton label="Stop selecting" size="icon-sm" onClick={stopSelecting}><X /></IconButton>
    </Panel>}

    {state.accounts.length === 0 ? <EmptyState icon={<Users />} title="No accounts" action={<Button onClick={() => void addAccount()} disabled={adding}><Plus />Add account</Button>} />
      : visible.length + shownGroups.length === 0 ? <EmptyState icon={<Search />} title="No results" />
        : <div className="grid content-start gap-list @5xl:grid-cols-2 @[96rem]:grid-cols-3">
          {pinnedGroups.length > 0 && <>{grouped && <h2 className="col-span-full text-xs font-medium text-muted-foreground">Pinned</h2>}{pinnedGroups.map(groupCard)}</>}
          {visible.map((account, index) => <Fragment key={account.id}>
          {grouped && !(account.pinned && pinnedGroups.length > 0) && (index === 0 || visible[index - 1].pinned !== account.pinned) && <h2 className={cn("col-span-full text-xs font-medium text-muted-foreground", (index > 0 || pinnedGroups.length > 0) && "mt-2")}>{account.pinned ? "Pinned" : "Other accounts"}</h2>}
          <AccountCard data-account-id={account.id} account={account}
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
            {nextJoin[account.id] && <Hint label={`Next join only: ${nextJoin[account.id].name}. Then ${account.placeId ? placeLabel(state, account.placeId) : "the default destination"}.`}>
              <Badge variant="outline" className="min-w-0 shrink text-muted-foreground"><Repeat1 /><span className="truncate">{nextJoin[account.id].name}</span></Badge>
            </Hint>}
            {account.placeId && <Hint label={`Destination: ${placeLabel(state, account.placeId)} (${account.placeId})`}><Badge variant="outline" className="min-w-0 shrink text-muted-foreground">{targetUserId(account.placeId) === undefined ? <MapPin /> : <UserRound />}<span className="truncate">{placeLabel(state, account.placeId)}</span></Badge></Hint>}
            {presenceLabel(account) && <Hint label={presenceLabel(account)}><Badge variant="secondary" className="min-w-0 shrink"><PresenceMark account={account} small /><span className="truncate">{presenceShort(account)}</span></Badge></Hint>}
            {settings.sortOrder === "last_played" && account.presence !== "playing" && <span className="shrink-0 text-xs text-muted-foreground"
              title={account.lastPlayedAt ? new Date(account.lastPlayedAt < 1_000_000_000_000 ? account.lastPlayedAt * 1000 : account.lastPlayedAt).toLocaleString() : undefined}>{relativeTime(account.lastPlayedAt)}</span>}
          </>}
          actions={<><div className="mr-1 flex items-center gap-1">
            <span data-account-actions={account.id} className={cn("grid transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none", menuFor === account.id ? "grid-cols-[1fr] opacity-100" : "grid-cols-[0fr] opacity-0")}
              inert={menuFor !== account.id}>
              <span className="flex min-w-0 items-center gap-1 overflow-hidden" role="group" aria-label={`Actions for ${accountName(account)}`}>
                {(menuFor === account.id || actionsFor === account.id) && <>
                  {reorderable && <>
                    <IconButton label="Move up" size="icon-sm" className="text-muted-foreground" disabled={index === 0} onClick={() => move(account.id, -1)}><ArrowUp /></IconButton>
                    <IconButton label="Move down" size="icon-sm" className="text-muted-foreground" disabled={index === visible.length - 1} onClick={() => move(account.id, 1)}><ArrowDown /></IconButton>
                  </>}
                  <IconButton label={account.placeId ? "Change destination" : "Set destination"} size="icon-sm" className="text-muted-foreground"
                    onClick={() => { setMenuFor(undefined); searchDestinationFor(account.id); navigate("/accounts/places"); }}><MapPin /></IconButton>
                  {nextJoin[account.id] && <IconButton label="Clear the next join destination" size="icon-sm" className="text-muted-foreground" onClick={() => { setMenuFor(undefined); setNextJoin(account.id); }}><Undo2 /></IconButton>}
                  {account.placeId && <IconButton label="Use default destination" size="icon-sm" className="text-muted-foreground" onClick={() => { setMenuFor(undefined); void setAccountPlace(account, null); }}><MapPinOff /></IconButton>}
                  {groups.length ? <DropdownMenu>
                    <Hint label="Add to group"><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Add to group" />}><FolderInput /></DropdownMenuTrigger></Hint>
                    <DropdownMenuContent className="w-48">
                      {groups.map((group) => <DropdownMenuCheckboxItem key={group.id} checked={group.accountIds.includes(account.id)}
                        onCheckedChange={(checked) => saveGroup({ ...group, accountIds: checked ? [...group.accountIds, account.id] : group.accountIds.filter((id) => id !== account.id) })}>
                        <span className="truncate">{group.name}</span>
                      </DropdownMenuCheckboxItem>)}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => { setMenuFor(undefined); newGroup([account.id]); }}><FolderPlus />New group</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                    : <IconButton label="Add to a new group" size="icon-sm" className="text-muted-foreground" onClick={() => { setMenuFor(undefined); newGroup([account.id]); }}><FolderInput /></IconButton>}
                  {!settings.compactMode && <IconButton label="Edit note" size="icon-sm" className="text-muted-foreground"
                    onClick={() => { setMenuFor(undefined); document.querySelector<HTMLTextAreaElement>(`[data-account-id="${account.id}"] textarea[name=notes]`)?.focus(); }}><NotebookPen /></IconButton>}
                  <IconButton label="Copy username" size="icon-sm" className="text-muted-foreground"
                    onClick={() => { setMenuFor(undefined); navigator.clipboard.writeText(account.name).then(() => done(`Copied @${account.name}.`), (error) => notify(failure(`The username wasn't copied. Does retrying help?`, error))); }}><Copy /></IconButton>
                  <IconButton label="Open Roblox profile" size="icon-sm" className="text-muted-foreground"
                    onClick={() => { setMenuFor(undefined); void bridge.openExternal(`https://www.roblox.com/users/${account.id}/profile`); }}><ExternalLink /></IconButton>
                  {!account.sessionExpired && <IconButton label="Sign in again" size="icon-sm" className="text-muted-foreground" onClick={() => { setMenuFor(undefined); void signIn(account.id); }}><KeyRound /></IconButton>}
                  <IconButton label="Remove" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => { setMenuFor(undefined); confirm({ title: `Remove ${accountName(account)}?`, message: "Removes the account and its saved session from this device.", action: "Remove", danger: true, run: async () => { await bridge.removeAccount(account.id); done(`Removed ${accountName(account)}.`); await refresh(); } }); }}><Trash2 /></IconButton>
                </>}
              </span>
            </span>
            <IconButton label={menuFor === account.id ? "Hide actions" : `More actions for ${accountName(account)}`} size="icon-sm" aria-expanded={menuFor === account.id} data-actions-toggle={account.id}
              className={cn("text-muted-foreground", menuFor === account.id ? "opacity-100" : reveal)} onClick={() => setMenuFor(menuFor === account.id ? undefined : account.id)}>
              {menuFor === account.id ? <X /> : <MoreHorizontal />}
            </IconButton>
            <IconButton label={account.pinned ? "Unpin from dashboard" : "Pin to dashboard"} size="icon-sm" aria-pressed={account.pinned}
              className={cn("text-muted-foreground", !account.pinned && reveal)} onClick={() => void setAccountPinned(account, !account.pinned)}>
              <Star className={cn(account.pinned && "fill-current")} />
            </IconButton></div>
            {account.sessionExpired
              ? <Button variant="outline" size="sm" onClick={() => void signIn(account.id)} aria-label={`Sign in again as ${accountName(account)}`}><KeyRound />Sign in again</Button>
              : <Button variant="outline" size="sm" onClick={() => joining.includes(account.id) ? cancelJoin([account.id]) : join([account.id])}
                aria-label={joining.includes(account.id) ? `Cancel the join for ${accountName(account)}` : `Join as ${accountName(account)}`}>{joining.includes(account.id) ? <><Spinner />Cancel</> : <><Play />Join</>}</Button>}
          </>}>
          <WidgetSlot name="accounts.row" props={{ account }} wrap={(children) => <div className="mt-1 flex flex-wrap items-center gap-2">{children}</div>} />
          {settings.compactMode && query && matchAccount(account, query) === "notes" && <p className="mt-0.5 truncate text-xs text-muted-foreground" title={account.notes}>Note: {account.notes}</p>}
          {!settings.compactMode && <textarea rows={1} name="notes" defaultValue={account.notes} placeholder="Add a note" aria-label={`Notes for ${accountName(account)}`}
            className="-mx-1 mt-0.5 block max-h-16 w-full resize-none rounded-lg bg-transparent px-1 text-xs text-muted-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
            onBlur={(event) => { if (event.target.value !== account.notes) void bridge.updateAccountNotes(account.id, event.target.value).then(refresh).catch((error) => notify(failure(`The note wasn't saved. Does retrying help?`, error))); }} />}
        </AccountCard></Fragment>)}
          {otherGroups.length > 0 && <><h2 className={cn("col-span-full text-xs font-medium text-muted-foreground", (visible.length > 0 || pinnedGroups.length > 0) && "mt-2")}>Groups</h2>{otherGroups.map(groupCard)}</>}
        </div>}
    <span className="sr-only" aria-live="polite">{adding ? "Roblox sign-in window open." : ""}</span>
  </Screen>;
}
