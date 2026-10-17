import { Gamepad2, KeyRound, Play, Plus, Puzzle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { accountName, relativeTime, sortAccounts } from "@/logic";
import { AccountCard, Commitments, Panel, SectionTitle, Screen, StatTile, WidgetFrame, placeLabel, presenceLabel, type ScreenProps } from "@/shared";
import { WidgetSlot } from "@/widgets/host";
import { WIDGETS_AVAILABLE } from "@/screens/Widgets";

export function Dashboard({ state, navigate, join, signIn }: ScreenProps) {
  const { accounts, settings, installedWidgets } = state;
  const hero = sortAccounts(accounts, "last_played")[0];
  const inGame = accounts.filter(({ presence }) => presence === "playing").length;
  const expired = accounts.filter(({ sessionExpired }) => sessionExpired).length;
  const enabledWidgets = installedWidgets.filter(({ enabled }) => enabled);
  const place = hero?.placeId || settings.placeId;
  const recent = sortAccounts(accounts.filter(({ lastPlaceId }) => lastPlaceId), "last_played");

  return <Screen title="Dashboard">
    {hero ? <AccountCard account={hero} showAvatar={settings.showAvatars} avatarClassName="size-14" nameClassName="text-lg font-semibold tracking-tight"
      className="flex-wrap gap-4 rounded-2xl p-5" eyebrow={<p className="text-xs text-muted-foreground">Continue as</p>}
      actions={hero.sessionExpired
        ? <Button size="lg" className="px-4" onClick={() => void signIn(hero.id)}><KeyRound />Sign in again</Button>
        : <Button size="lg" className="px-4" onClick={() => join([hero.id])}><Play />Join</Button>}>
      <p className="truncate text-xs text-muted-foreground">
        {presenceLabel(hero) || relativeTime(hero.lastPlayedAt)}{place && ` · ${placeLabel(state, place)}`}
      </p>
    </AccountCard> : <Panel className="flex flex-wrap items-center gap-4 rounded-2xl p-5">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">No accounts</p>
        <p className="text-sm text-muted-foreground">Add a Roblox account to begin.</p>
      </div>
      <Button size="lg" className="px-4" onClick={() => navigate("/accounts")}><Plus />Add account</Button>
    </Panel>}

    <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
      <StatTile icon={<Users />} label="Accounts" value={accounts.length} onClick={() => navigate("/accounts")} />
      <StatTile icon={<Gamepad2 />} label="In game" value={inGame} onClick={() => navigate("/accounts")} />
      {expired > 0 && <StatTile icon={<KeyRound />} label="Need to sign in again" value={expired} onClick={() => navigate("/accounts")} />}
      <StatTile icon={<Puzzle />} label="Widgets enabled" value={`${enabledWidgets.length}/${installedWidgets.length}`} onClick={WIDGETS_AVAILABLE ? () => navigate("/widgets") : undefined} />
      <WidgetSlot name="dashboard.stats" props={{}} />
    </div>

    {recent.length > 0 && <section className="flex flex-col gap-2">
      <SectionTitle>Recently played</SectionTitle>
      <div className="flex flex-col gap-2">
        {recent.map((account) => {
          const lastPlace = placeLabel(state, account.lastPlaceId!);
          return <AccountCard key={account.id} account={account} showAvatar={settings.showAvatars} avatarClassName="size-8" className="px-4 py-3"
            actions={account.sessionExpired
              ? <Button variant="outline" size="sm" aria-label={`Sign in again as ${accountName(account)}`} onClick={() => void signIn(account.id)}><KeyRound />Sign in again</Button>
              : <Button variant="outline" size="sm" aria-label={`Join ${lastPlace} as ${accountName(account)}`} onClick={() => join([account.id], account.lastPlaceId)}><Play />Join</Button>}>
            <p className="truncate text-xs text-muted-foreground" title={`Place ID ${account.lastPlaceId}`}>{lastPlace} · {relativeTime(account.lastPlayedAt)}</p>
          </AccountCard>;
        })}
      </div>
    </section>}

    <WidgetSlot name="dashboard.sections" props={{}} wrap={(children) => <div className="flex flex-col gap-4">{children}</div>} />

    {enabledWidgets.filter((widget) => widget.hasDashboardTile).map((widget) => <section key={widget.id} className="flex flex-col gap-2">
      <SectionTitle>{widget.name}</SectionTitle>
      <WidgetFrame widget={widget} surface="dashboard" title={`${widget.name} dashboard`} />
    </section>)}

    <footer className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-2 text-xs text-muted-foreground">
      <Commitments platform={state.platform} className="-ml-1.5" />
      <Button variant="link" size="sm" className="ml-auto h-auto px-0 text-xs text-muted-foreground" onClick={() => navigate("/settings")}>Details</Button>
    </footer>
  </Screen>;
}
