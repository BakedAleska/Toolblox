import { Copy, ExternalLink, FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { bridge, describeError, isDemo, previewUpdater } from "@/bridge";
import type { ThemeStore } from "@/lib/theme";
import { ThemesTab } from "@/screens/Themes";
import { ChoiceRow, Group, Panel, Screen, Spinner, SwitchRow, priorityLabels, type ScreenProps } from "@/shared";
import type { ClientPriority, TileSize } from "@/types";

type Tab = "general" | "accounts" | "themes";

const priorityOptions = (Object.keys(priorityLabels) as ClientPriority[]).map((value) => ({ value, label: priorityLabels[value] }));
const tileOptions: { value: TileSize; label: string }[] = [{ value: "fit", label: "Fit screen" }, { value: "medium", label: "Medium" }, { value: "small", label: "Small" }];

export function SettingsScreen({ themes, ...props }: ScreenProps & { themes: ThemeStore }) {
  const { state, notify, patchSettings } = props;
  const [tab, setTab] = useState<Tab>("general");
  const { settings } = state;
  const windows = state.platform === "windows";

  return <Screen title="Settings">
    <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-4">
      <TabsList className="bg-transparent p-0">
        <TabsTrigger value="general" className="flex-none px-3">General</TabsTrigger>
        <TabsTrigger value="accounts" className="flex-none px-3">Accounts</TabsTrigger>
        <TabsTrigger value="themes" className="flex-none px-3">Themes</TabsTrigger>
      </TabsList>

      <TabsContent value="general" className="flex flex-col gap-4">
        <Group title="Appearance"><Panel className="divide-y">
          <ChoiceRow title="Sidebar position" value={settings.sidebarPosition} options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }]} change={(value) => void patchSettings("sidebarPosition", value)} />
        </Panel></Group>
        <Group title="Window"><Panel className="divide-y">
          <SwitchRow title="Launch at startup" description="Open Toolblox at sign-in." checked={settings.openOnLaunch} change={(value) => void patchSettings("openOnLaunch", value)} />
          <SwitchRow title="Run in background" description={`Keep running in the ${state.platform === "macos" ? "menu bar" : "system tray"} after the window closes.`} checked={settings.runInBackground} change={(value) => void patchSettings("runInBackground", value)} />
          <SwitchRow title="Always on top" checked={settings.alwaysOnTop} change={(value) => void patchSettings("alwaysOnTop", value)} />
          {!isDemo() && <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Mini mode</p>
              <p className="text-xs text-muted-foreground">Shrink to a small account list that stays on top. Messages appear as system notifications.</p>
            </div>
            <Button variant="outline" size="sm" onClick={props.openMini}>Open</Button>
          </div>}
        </Panel></Group>
        <LogGroup logsPath={state.logsPath} notify={notify} />
        <Group title="About"><Panel className="divide-y">
          {isDemo() && <div className="flex items-center gap-2 px-4 py-3">
            <span className="mr-auto text-xs text-muted-foreground">Startup update previews</span>
            <Button variant="ghost" size="sm" onClick={() => previewUpdater("update")}>Update</Button>
            <Button variant="ghost" size="sm" onClick={() => previewUpdater("failure")}>Failure</Button>
          </div>}
          <div className="space-y-1 px-4 py-3">
            <p className="text-sm font-medium">Legal</p>
            <p className="text-xs text-muted-foreground">Toolblox isn't affiliated with or endorsed by Roblox Corporation. It's provided as is, without warranty, under the MIT License.</p>
            <div className="flex flex-wrap gap-x-4">
              <Button variant="link" size="sm" className="h-auto px-0" onClick={() => void bridge.openExternal("https://toolblox.dev/legal/#license")}>License<ExternalLink /></Button>
              <Button variant="link" size="sm" className="h-auto px-0" onClick={() => void bridge.openExternal("https://toolblox.dev/legal/#privacy")}>Privacy policy<ExternalLink /></Button>
              <Button variant="link" size="sm" className="h-auto px-0" onClick={() => void bridge.openExternal("https://toolblox.dev/legal/#security")}>Security policy<ExternalLink /></Button>
              <Button variant="link" size="sm" className="h-auto px-0" onClick={() => void bridge.openExternal(`https://github.com/BakedAleska/Toolblox/releases/download/v${state.version}/THIRD-PARTY-NOTICES.txt`)}>Third-party notices<ExternalLink /></Button>
            </div>
          </div>
        </Panel></Group>
      </TabsContent>

      <TabsContent value="accounts" className="flex flex-col gap-4">
        <Group title="List"><Panel className="divide-y">
          <ChoiceRow title="Sort order" value={settings.sortOrder} options={[{ value: "last_played", label: "Last played" }, { value: "alphabetical", label: "A–Z" }, { value: "manual", label: "Manual" }]} change={(value) => void patchSettings("sortOrder", value)} />
          <SwitchRow title="Show avatars" checked={settings.showAvatars} change={(value) => void patchSettings("showAvatars", value)} />
          <SwitchRow title="Compact list" description="Hide notes and reduce row height." checked={settings.compactMode} change={(value) => void patchSettings("compactMode", value)} />
          <SwitchRow title="Game details" description="Show the game for accounts in game. Uses extra requests to Roblox." checked={settings.showGameNames} change={(value) => void patchSettings("showGameNames", value)} />
        </Panel></Group>
        <Group title="Joining"><Panel className="divide-y">
          <SwitchRow title="Minimize on join" description="Applies to manual joins." checked={settings.minimizeOnJoin} change={(value) => void patchSettings("minimizeOnJoin", value)} />
          <SwitchRow title="Multiple instances" description="Run several Roblox clients at once." checked={settings.multiInstance} change={(value) => void patchSettings("multiInstance", value)} />
        </Panel></Group>
        <Group title="Clients"><Panel className="divide-y">
          <ChoiceRow title="Priority" description="Applies to new clients. Accounts can override it." value={settings.clientPriority} options={priorityOptions} change={(value) => void patchSettings("clientPriority", value)} />
          {windows && <ChoiceRow title="CPU cores per client" description="Spreads new clients across the cores." value={String(settings.cpuCores)}
            options={[{ value: "0", label: "All" }, { value: "1", label: "1" }, { value: "2", label: "2" }, { value: "4", label: "4" }]} change={(value) => void patchSettings("cpuCores", Number(value))} />}
          {windows && <ChoiceRow title="Tile size" description="Smaller windows render fewer pixels." value={settings.tileSize} options={tileOptions} change={(value) => void patchSettings("tileSize", value)} />}
        </Panel></Group>
        <Group title="Disconnects"><Panel className="divide-y">
          <SwitchRow title="Auto-rejoin" description="Pauses after repeated failures." checked={settings.autoRejoin} change={(value) => void patchSettings("autoRejoin", value)} />
          <SwitchRow title="Disconnect notifications" description="When an account leaves a game or auto-rejoin pauses." checked={settings.notifyOnDrop} change={(value) => void patchSettings("notifyOnDrop", value)} />
        </Panel></Group>
      </TabsContent>

      <TabsContent value="themes" className="flex flex-col gap-4">
        <ThemesTab {...props} themes={themes} />
      </TabsContent>
    </Tabs>
  </Screen>;
}

/** Lines shown in the log view. Copying includes up to 2,000. */
const LOG_VIEW_LINES = 300;

function LogGroup({ logsPath, notify }: { logsPath: string; notify: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<string>();
  const [loading, setLoading] = useState(false);
  const view = useRef<HTMLPreElement>(null);
  const load = async () => {
    setLoading(true);
    try { setLog(await bridge.readLog(LOG_VIEW_LINES)); }
    catch (error) { setLog(undefined); notify(`The log couldn't be read. Does reopening Settings help? (${describeError(error)})`); }
    finally { setLoading(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(await bridge.readLog(2000) || "The log is empty."); notify("Copied."); }
    catch (error) { notify(`The log wasn't copied. Does retrying help? (${describeError(error)})`); }
  };
  const openFolder = () => bridge.openLogFolder().catch((error) => notify(`The log folder couldn't be opened. Does it still exist? (${describeError(error)})`));
  useEffect(() => { if (view.current) view.current.scrollTop = view.current.scrollHeight; }, [log]);

  return <Group title="Diagnostics"><Panel className="divide-y">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-48 flex-1">
        <p className="text-sm font-medium">Log</p>
        <p className="text-xs text-muted-foreground">Recent activity and errors, with sign-in data removed.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" aria-expanded={open} aria-controls="log-view" onClick={() => { setOpen(!open); if (!open) void load(); }}>{open ? "Hide" : "Show"}</Button>
        <Button variant="outline" size="sm" onClick={() => void copy()}><Copy />Copy</Button>
        <Button variant="outline" size="sm" onClick={() => void openFolder()} disabled={!logsPath} title={logsPath || undefined}><FolderOpen />Open folder</Button>
      </div>
    </div>
    {open && <div id="log-view" className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-2">
        <p className="mr-auto text-xs text-muted-foreground" aria-live="polite">{loading ? "Loading…" : `Last ${LOG_VIEW_LINES} lines, oldest first.`}</p>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>{loading ? <Spinner /> : <RefreshCw />}Refresh</Button>
      </div>
      <pre ref={view} tabIndex={0} aria-label="Recent log lines" className="max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">{log || (loading ? "" : "The log is empty.")}</pre>
    </div>}
  </Panel></Group>;
}
