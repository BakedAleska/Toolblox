import { ChevronDown, KeyRound, Maximize2, Play } from "lucide-react";
import { useEffect, useState, type PointerEvent } from "react";
import { bridge } from "@/bridge";
import { cn } from "@/lib/utils";
import { accountName, relativeTime, sortAccounts } from "@/logic";
import { Avatar, IconButton, placeLabel, type ScreenProps } from "@/shared";

/** Heights in logical pixels: the bar, each account row, the list's padding, and the most rows
 * shown before the list scrolls. */
const BAR = 40;
const ROW = 40;
const LIST_PADDING = 9;
const MAX_ROWS = 8;

/** The mini window: a small bar, always on top, that drops down into the account list. The window
 * resizes to fit, and dragging the bar moves it. */
export function MiniWindow({ state, join, signIn, exit, notify }: Pick<ScreenProps, "state" | "join" | "signIn" | "notify"> & { exit: () => void }) {
  const [open, setOpen] = useState(false);
  const accounts = sortAccounts(state.accounts, "last_played");
  const playing = accounts.filter(({ presence }) => presence === "playing").length;
  const height = BAR + (open && accounts.length ? Math.min(accounts.length, MAX_ROWS) * ROW + LIST_PADDING : 0);

  useEffect(() => {
    bridge.setMiniWindow(height).catch((error) => { exit(); notify(`Mini mode couldn't open. Does retrying help? (${String(error)})`); });
  }, [height]);

  const drag = (event: PointerEvent) => {
    if (event.button === 0 && !(event.target as HTMLElement).closest("button")) void bridge.startWindowDrag();
  };

  return <div className="flex h-full flex-col overflow-hidden bg-background">
    <div className="flex h-10 shrink-0 cursor-grab items-center gap-1 px-1.5 select-none active:cursor-grabbing" onPointerDown={drag}>
      <img src={`${import.meta.env.BASE_URL}assets/logo.svg`} alt="" width="18" height="18" className="mx-1 shrink-0" />
      <button type="button" aria-expanded={open} aria-controls="mini-accounts" onClick={() => setOpen((value) => !value)}
        className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
        <span className="truncate"><span className="font-medium tabular-nums">{playing}</span> of {accounts.length} in game</span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      <IconButton label="Restore window" size="icon-sm" className="text-muted-foreground" onClick={exit}><Maximize2 /></IconButton>
    </div>
    {open && <ul id="mini-accounts" className="flex-1 overflow-y-auto border-t px-1 py-1">
      {accounts.map((account) => {
        const detail = account.sessionExpired ? "Session expired"
          : account.presence === "playing" ? account.gameName || (account.gamePlaceId ? placeLabel(state, String(account.gamePlaceId)) : "In game")
          : relativeTime(account.lastPlayedAt);
        return <li key={account.id} className="flex h-10 items-center gap-2 rounded-lg px-1.5 hover:bg-muted/50">
          {state.settings.showAvatars && <Avatar account={account} className="size-6" />}
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm">{accountName(account)}</span>
            <span className="block truncate text-xs text-muted-foreground">{detail}</span>
          </span>
          {account.sessionExpired
            ? <IconButton label={`Sign in again as ${accountName(account)}`} size="icon-sm" onClick={() => void signIn(account.id)}><KeyRound /></IconButton>
            : <IconButton label={`Join as ${accountName(account)}`} size="icon-sm" onClick={() => join([account.id])}><Play /></IconButton>}
        </li>;
      })}
    </ul>}
  </div>;
}
