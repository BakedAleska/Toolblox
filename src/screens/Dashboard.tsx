import { Gamepad2, Play, Plus, Puzzle, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { accountName, relativeTime, sortAccounts } from "@/logic";
import { Avatar, Panel, SectionTitle, Screen, StatTile, WidgetFrame, placeLabel, presenceLabel, type ScreenProps } from "@/shared";
import { WidgetSlot } from "@/widgets/host";

export function Dashboard({ state, navigate, join }: ScreenProps) {
  const { accounts, settings, installedWidgets } = state;
  const hero = sortAccounts(accounts, "last_played")[0];
  const inGame = accounts.filter(({ presence }) => presence === "playing").length;
  const enabledWidgets = installedWidgets.filter(({ enabled }) => enabled);
  const place = hero?.placeId || settings.placeId;
  const recent = sortAccounts(accounts.filter(({ lastPlaceId }) => lastPlaceId), "last_played");

  return <Screen title="Dashboard">
    <Panel className="flex flex-wrap items-center gap-4 rounded-2xl p-5">
      {hero ? <>
        {settings.showAvatars && <Avatar account={hero} className="size-14" />}
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">Continue as</p>
          <p className="truncate text-lg font-semibold tracking-tight">{accountName(hero)}</p>
          <p className="truncate text-xs text-muted-foreground">
            {presenceLabel(hero) || relativeTime(hero.lastPlayedAt)}{place && ` · ${placeLabel(state, place)}`}
          </p>
        </div>
        <Button size="lg" className="px-4" onClick={() => join([hero.id])}><Play />Join</Button>
      </> : <>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">No accounts</p>
          <p className="text-sm text-muted-foreground">Add a Roblox account to begin.</p>
        </div>
        <Button size="lg" className="px-4" onClick={() => navigate("/accounts")}><Plus />Add account</Button>
      </>}
    </Panel>

    <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
      <StatTile icon={<Users />} label="Accounts" value={accounts.length} onClick={() => navigate("/accounts")} />
      <StatTile icon={<Gamepad2 />} label="In game" value={inGame} onClick={() => navigate("/accounts")} />
      <StatTile icon={<Puzzle />} label="Widgets enabled" value={`${enabledWidgets.length}/${installedWidgets.length}`} onClick={() => navigate("/widgets")} />
      <WidgetSlot name="dashboard.stats" props={{}} />
    </div>

    {recent.length > 0 && <section className="flex flex-col gap-2">
      <SectionTitle>Recently played</SectionTitle>
      <div className="flex flex-col gap-2">
        {recent.map((account) => {
          const lastPlace = placeLabel(state, account.lastPlaceId!);
          return <Panel key={account.id} className="flex items-center gap-3 px-4 py-3">
            {settings.showAvatars && <Avatar account={account} className="size-8" />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{accountName(account)}</p>
              <p className="truncate text-xs text-muted-foreground" title={`Place ID ${account.lastPlaceId}`}>{lastPlace} · {relativeTime(account.lastPlayedAt)}</p>
            </div>
            <Button variant="outline" size="sm" aria-label={`Join ${lastPlace} as ${accountName(account)}`} onClick={() => join([account.id], account.lastPlaceId)}><Play />Join</Button>
          </Panel>;
        })}
      </div>
    </section>}

    <WidgetSlot name="dashboard.sections" props={{}} wrap={(children) => <div className="flex flex-col gap-4">{children}</div>} />

    {enabledWidgets.filter((widget) => widget.hasDashboardTile).map((widget) => <section key={widget.id} className="flex flex-col gap-2">
      <SectionTitle>{widget.name}</SectionTitle>
      <WidgetFrame widget={widget} surface="dashboard" title={`${widget.name} dashboard`} />
    </section>)}

    <p className="mt-auto flex items-start gap-2 pt-2 text-xs text-muted-foreground">
      <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      All data is stored on this device. Roblox sessions are kept in the operating system's credential store, and no telemetry is collected.
    </p>
  </Screen>;
}
