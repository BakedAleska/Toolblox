import { ArrowLeft, ListChecks, MapPin, MapPinOff, MoreHorizontal, Pencil, Play, Star, Trash2, UserRound, Users, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { accountName, targetUserId } from "@/logic";
import { Avatar, Group, Hint, IconButton, Panel, Screen, Spinner, placeLabel, type ScreenProps } from "@/shared";
import type { Account, AccountGroup, AppState } from "@/types";

/** The group's accounts that still exist, in group order. */
export const groupMembers = (state: AppState, group: AccountGroup) =>
  group.accountIds.map((id) => state.accounts.find((account) => account.id === id)).filter((account): account is Account => account !== undefined);

/** Whether a search matches the group's name, its notes, or one of its accounts' names. */
export const matchGroup = (state: AppState, group: AccountGroup, query: string) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = [group.name, group.notes, ...groupMembers(state, group).flatMap(({ name, displayName }) => [name, displayName])].join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
};

/** The first three members' portraits, overlapping, with a count of the rest. */
export function GroupStack({ members, showAvatars, className = "size-9" }: { members: Account[]; showAvatars: boolean; className?: string }) {
  return <span className="flex shrink-0 items-center" aria-hidden="true">
    {members.length === 0 && <span className={cn("grid place-items-center rounded-full bg-muted text-muted-foreground", className)}><Users className="size-1/2" /></span>}
    {members.slice(0, 3).map((account, index) => <Avatar key={account.id} account={showAvatars ? account : { ...account, avatarUrl: undefined }} status={false}
      className={cn("ring-2 ring-card", className, index > 0 && "-ml-3")} />)}
    {members.length > 3 && <span className={cn("-ml-3 grid place-items-center rounded-full bg-muted text-xs font-medium text-muted-foreground tabular-nums ring-2 ring-card", className)}>+{members.length - 3}</span>}
  </span>;
}

type GroupCardProps = Pick<ScreenProps, "state" | "join" | "joining" | "cancelJoin"> & {
  group: AccountGroup;
  /** Shows only the portraits, name, and Join, as on the dashboard. */
  simple?: boolean;
  className?: string;
  patchGroup?: (group: AccountGroup) => void;
  edit?: () => void;
  selectMembers?: () => void;
  setDestination?: () => void;
  remove?: () => void;
};

/** A group with its portraits, name, member count, and destination. Join joins every member. */
export function GroupCard({ state, join, joining, cancelJoin, group, simple = false, className, patchGroup, edit, selectMembers, setDestination, remove }: GroupCardProps) {
  const [open, setOpen] = useState(false);
  /** Actions stay rendered briefly after closing so they slide shut. */
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    if (open) { setRendered(true); return; }
    const timer = window.setTimeout(() => setRendered(false), 200);
    return () => window.clearTimeout(timer);
  }, [open]);
  const members = groupMembers(state, group);
  const ids = members.map(({ id }) => id);
  const joiningIds = ids.filter((id) => joining.includes(id));
  const busy = joiningIds.length > 0;
  useEffect(() => {
    if (!open) return;
    const outside = (event: globalThis.PointerEvent) => { if (!(event.target as Element).closest?.(`[data-group-actions="${group.id}"], [role=dialog], [role=alertdialog]`)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
  }, [open, group.id]);
  const act = (run?: () => void) => () => { setOpen(false); run?.(); };
  const reveal = "opacity-0 transition-opacity duration-200 motion-reduce:transition-none group-hover:opacity-100 group-has-focus-visible:opacity-100 pointer-coarse:opacity-100";
  const action = (label: string, icon: ReactNode, run?: () => void, extra?: string) =>
    <IconButton label={label} size="icon-sm" className={cn("text-muted-foreground", extra)} onClick={act(run)}>{icon}</IconButton>;

  return <Panel className={cn("group flex items-center gap-3 p-3", className)}>
    <GroupStack members={members} showAvatars={state.settings.showAvatars} className={simple || state.settings.compactMode ? "size-8" : "size-9"} />
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate text-sm font-medium" title={group.name}>{group.name}</span>
        {!simple && group.placeId && <Hint label={`Group destination: ${placeLabel(state, group.placeId)}`}>
          <Badge variant="outline" className="min-w-0 shrink text-muted-foreground">{targetUserId(group.placeId) === undefined ? <MapPin /> : <UserRound />}<span className="truncate">{placeLabel(state, group.placeId)}</span></Badge>
        </Hint>}
      </div>
      <p className="truncate text-xs text-muted-foreground">{members.length} {members.length === 1 ? "account" : "accounts"}</p>
      {!simple && patchGroup && !state.settings.compactMode && <textarea key={group.notes} rows={1} name="notes" maxLength={1000} defaultValue={group.notes} placeholder="Add a note" aria-label={`Notes for ${group.name}`}
        className="-mx-1 mt-0.5 block max-h-16 w-full min-w-0 resize-none rounded-lg bg-transparent px-1 text-xs text-muted-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
        onBlur={(event) => { const notes = event.target.value.trim(); if (notes !== group.notes) patchGroup({ ...group, notes }); }} />}
    </div>
    {!simple && <div className="mr-1 flex items-center gap-1">
      <span data-group-actions={group.id} inert={!open} className={cn("grid transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none", open ? "grid-cols-[1fr] opacity-100" : "grid-cols-[0fr] opacity-0")}>
        <span className="flex min-w-0 items-center gap-1 overflow-hidden" role="group" aria-label={`Actions for ${group.name}`}>
          {(open || rendered) && <>
          {action("Edit group", <Pencil />, edit)}
          {action("Select its accounts", <ListChecks />, selectMembers)}
          {action(group.placeId ? "Change group destination" : "Set group destination", <MapPin />, setDestination)}
          {group.placeId && action("Use each account's destination", <MapPinOff />, () => patchGroup?.({ ...group, placeId: undefined }))}
          {action("Delete group", <Trash2 />, remove, "hover:text-destructive")}
          </>}
        </span>
      </span>
      <IconButton label={open ? "Hide actions" : `More actions for ${group.name}`} size="icon-sm" aria-expanded={open} data-group-actions={group.id}
        className={cn("text-muted-foreground", open ? "opacity-100" : reveal)} onClick={() => setOpen(!open)}>{open ? <X /> : <MoreHorizontal />}</IconButton>
      <IconButton label={group.pinned ? "Unpin group from dashboard" : "Pin group to dashboard"} size="icon-sm" aria-pressed={group.pinned}
        className={cn("text-muted-foreground", !group.pinned && reveal)} onClick={() => patchGroup?.({ ...group, pinned: !group.pinned })}>
        <Star className={cn(group.pinned && "fill-current")} />
      </IconButton>
    </div>}
    {busy
      ? <Button variant="outline" size={simple ? "icon-sm" : "sm"} onClick={() => cancelJoin(joiningIds)} aria-label={`Cancel the joins for ${group.name}`}><Spinner />{!simple && "Cancel"}</Button>
      : <Button variant="outline" size={simple ? "icon-sm" : "sm"} disabled={!members.length} onClick={() => join(ids, group.placeId || undefined)}
        aria-label={`Join as every account in ${group.name}`}><Play />{!simple && "Join"}</Button>}
  </Panel>;
}

/** The group the next editor page opens, a new one when it isn't saved yet. */
let editorGroup: AccountGroup | undefined;
export const editGroup = (group: AccountGroup) => { editorGroup = group; };

/** Creates or edits the group set by `editGroup`: its name and accounts. Without one, it
 * returns to Accounts. */
export function GroupEditor({ state, navigate, patchSettings, done }: ScreenProps) {
  const [group] = useState(() => editorGroup);
  useEffect(() => { if (!group) navigate("/accounts"); }, [group]);
  const [name, setName] = useState(group?.name ?? "");
  const [members, setMembers] = useState(() => group?.accountIds.filter((id) => state.accounts.some((account) => account.id === id)) ?? []);
  if (!group) return null;
  const groups = state.settings.groups;
  const exists = groups.some(({ id }) => id === group.id);
  const toggle = (id: number) => setMembers((current) => current.includes(id) ? current.filter((member) => member !== id) : [...current, id]);
  const valid = name.trim().length > 0 && name.trim().length <= 50;
  const back = () => navigate("/accounts");
  const save = async () => {
    if (!valid) return;
    const saved = { ...group, name: name.trim(), accountIds: members };
    await patchSettings("groups", exists ? groups.map((current) => current.id === group.id ? saved : current) : [...groups, saved]);
    done(`Saved ${saved.name}.`);
    back();
  };
  return <Screen title={exists ? "Edit group" : "New group"} actions={<IconButton label="Back to accounts" onClick={back}><ArrowLeft /></IconButton>} tools={<>
    <Button variant="ghost" size="sm" onClick={back}>Cancel</Button>
    <Button size="sm" type="submit" form="group-editor" disabled={!valid}>Save</Button>
  </>}>
    <form id="group-editor" className="grid gap-6 @5xl:grid-cols-[minmax(0,22rem)_1fr] @5xl:items-start" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Group title="Details">
        <Panel className="grid gap-3 p-4">
          <label className="grid gap-1 text-xs text-muted-foreground">Name
            <Input autoFocus value={name} maxLength={50} placeholder="Farming alts" onChange={(event) => setName(event.target.value)} />
          </label>
        </Panel>
      </Group>
      <Group title={`Accounts (${members.length})`} action={state.accounts.length > 0 && <Button type="button" variant="ghost" size="sm" className="text-muted-foreground"
        onClick={() => setMembers(members.length === state.accounts.length ? [] : state.accounts.map(({ id }) => id))}>{members.length === state.accounts.length ? "Clear" : "Select all"}</Button>}>
        {state.accounts.length === 0
          ? <Panel className="p-4 text-sm text-muted-foreground">No accounts on this device.</Panel>
          : <Panel className="grid divide-y divide-border overflow-hidden @3xl:grid-cols-2 @3xl:divide-y-0 @3xl:gap-px @3xl:bg-border @7xl:grid-cols-3">
            {state.accounts.map((account) => <label key={account.id} className="flex cursor-pointer items-center gap-3 bg-card px-4 py-2.5 text-sm hover:bg-muted">
              <Checkbox checked={members.includes(account.id)} onCheckedChange={() => toggle(account.id)} />
              {state.settings.showAvatars && <Avatar account={account} className="size-7" status={false} />}
              <span className="min-w-0 truncate">{accountName(account)}</span>
            </label>)}
          </Panel>}
      </Group>
    </form>
  </Screen>;
}
