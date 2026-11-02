import { ArrowLeft, Code, Copy, ExternalLink, FolderOpen, PictureInPicture2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { bridge, describeError, isDemo, previewUpdater } from "@/bridge";
import type { ThemeStore } from "@/lib/theme";
import { newestFirst } from "@/logic";
import { ThemesTab } from "@/screens/Themes";
import { useWidgetHasSettings } from "@/screens/WidgetMenu";
import { ChoiceRow, Group, IconButton, Panel, Screen, SettingRow, Spinner, SwitchRow, WidgetFrame, failure, type ScreenProps } from "@/shared";
import { WidgetBoundary, useWidgetRegistry } from "@/widgets/host";
import type { WidgetSummary } from "@/types";

/** A core tab, or `widget:<id>` for a widget's settings. */
type Tab = "general" | "accounts" | "themes" | `widget:${string}`;
/** The last open tab, so returning from a settings subpage shows the tab it was opened from. */
let lastTab: Tab = "general";

/** Groups stack in one column, and sit in two once the page is wide. */
const columns = "grid items-start gap-4 @5xl:grid-cols-2";


/** Toolblox settings, with a tab for each enabled widget that has settings. `widgetId` opens that widget's tab. */
export function SettingsScreen({ themes, widgetId, ...props }: ScreenProps & { themes: ThemeStore; widgetId?: string }) {
  const { state, patchSettings } = props;
  const hasSettings = useWidgetHasSettings(state);
  const widgets = state.installedWidgets.filter(hasSettings);
  const [tab, setTab] = useState<Tab>(widgetId ? `widget:${widgetId}` : lastTab);
  useEffect(() => { if (widgetId) setTab(`widget:${widgetId}`); }, [widgetId]);
  useEffect(() => { lastTab = tab; }, [tab]);
  useEffect(() => { if (tab.startsWith("widget:") && !widgets.some(({ id }) => tab === `widget:${id}`)) setTab("general"); }, [tab, widgets.map(({ id }) => id).join()]);
  const { settings } = state;

  return <Screen title="Settings" tools={tab === "themes" && <IconButton label="Custom CSS" className="text-muted-foreground" onClick={() => props.navigate("/settings/css")}><Code /></IconButton>}>
    <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-4">
      <TabsList className="bg-transparent p-0">
        <TabsTrigger value="general" className="flex-none px-3">General</TabsTrigger>
        <TabsTrigger value="accounts" className="flex-none px-3">Accounts</TabsTrigger>
        <TabsTrigger value="themes" className="flex-none px-3">Themes</TabsTrigger>
        {widgets.map((widget) => <TabsTrigger key={widget.id} value={`widget:${widget.id}`} className="flex-none px-3">{widget.name}</TabsTrigger>)}
      </TabsList>

      <TabsContent value="general" className={columns}>
        <Group title="Layout"><Panel className="divide-y">
          <SwitchRow title="Show animations" checked={settings.showAnimations} change={(value) => void patchSettings("showAnimations", value)} />
          <SwitchRow title="Ignore system reduced motion" checked={settings.ignoreReducedMotion} disabled={!settings.showAnimations} change={(value) => void patchSettings("ignoreReducedMotion", value)} />
          <ChoiceRow title="Sidebar position" value={settings.sidebarPosition} options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }]} change={(value) => void patchSettings("sidebarPosition", value)} />
        </Panel></Group>
        <Group title="Window"><Panel className="divide-y">
          <SwitchRow title="Launch at startup" checked={settings.openOnLaunch} change={(value) => void patchSettings("openOnLaunch", value)} />
          <SwitchRow title="Run in background" checked={settings.runInBackground} change={(value) => void patchSettings("runInBackground", value)} />
          <SwitchRow title="Always on top" checked={settings.alwaysOnTop} change={(value) => void patchSettings("alwaysOnTop", value)} />
        </Panel></Group>
        <LogGroup navigate={props.navigate} />
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

      <TabsContent value="accounts" className={columns}>
        <Group title="List"><Panel className="divide-y">
          <ChoiceRow title="Sort order" value={settings.sortOrder} options={[{ value: "last_played", label: "Last played" }, { value: "alphabetical", label: "A–Z" }, { value: "manual", label: "Manual" }]} change={(value) => void patchSettings("sortOrder", value)} />
          <SwitchRow title="Show avatars" checked={settings.showAvatars} change={(value) => void patchSettings("showAvatars", value)} />
          <SwitchRow title="Compact list" checked={settings.compactMode} change={(value) => void patchSettings("compactMode", value)} />
          <SwitchRow title="Show game names" checked={settings.showGameNames} change={(value) => void patchSettings("showGameNames", value)} />
        </Panel></Group>
        <Group title="Joining"><Panel className="divide-y">
          <SwitchRow title="Minimize on join" checked={settings.minimizeOnJoin} change={(value) => void patchSettings("minimizeOnJoin", value)} />
          <SwitchRow title="Multiple instances" checked={settings.multiInstance} change={(value) => void patchSettings("multiInstance", value)} />
        </Panel></Group>
        <Group title="Disconnects"><Panel className="divide-y">
          <SwitchRow title="Auto-rejoin" checked={settings.autoRejoin} change={(value) => void patchSettings("autoRejoin", value)} />
          <SwitchRow title="Disconnect notifications" checked={settings.notifyOnDrop} change={(value) => void patchSettings("notifyOnDrop", value)} />
        </Panel></Group>
      </TabsContent>

      <TabsContent value="themes" className="flex flex-col gap-4">
        <ThemesTab {...props} themes={themes} />
      </TabsContent>

      {widgets.map((widget) => <TabsContent key={widget.id} value={`widget:${widget.id}`} className="flex flex-col gap-4">
        <WidgetSettingsTab widget={widget} {...props} />
      </TabsContent>)}
    </Tabs>
  </Screen>;
}

/**
 * A widget's settings: its own settings page or frame. In the main
 * window, a widget in its own window shows a link to that window instead, because its module runs there.
 */
export function WidgetSettingsTab({ widget, state, notify, popout = false }: Pick<ScreenProps, "state" | "notify"> & { widget: WidgetSummary; popout?: boolean }) {
  const { settingsPages } = useWidgetRegistry();
  const Custom = settingsPages.get(widget.id);
  const poppedOut = !popout && state.popouts.includes(widget.id);
  return <>
    {poppedOut ? <Panel><SettingRow title={`${widget.name} is in its own window`} description="Its other settings are in that window." control={() =>
      <Button variant="outline" size="sm" onClick={() => void bridge.openWidgetPopout(widget.id).catch((error) => notify(failure("The window couldn't be shown. Does retrying help?", error)))}><PictureInPicture2 />Show window</Button>} /></Panel>
      : Custom ? <WidgetBoundary widgetId={widget.id}><Custom /></WidgetBoundary>
      : widget.hasSettings ? <WidgetFrame widget={widget} surface="settings" title={`${widget.name} settings`} />
      : null}
  </>;
}

function LogGroup({ navigate }: Pick<ScreenProps, "navigate">) {
  return <Group title="Diagnostics"><Panel className="divide-y">
    <SettingRow title="Logs" control={() =>
      <Button variant="outline" size="sm" aria-label="View log" onClick={() => navigate("/settings/log")}>View</Button>} />
  </Panel></Group>;
}

/** The recent log on its own page, opened from Settings → General. */
export function LogScreen({ state, notify, navigate }: ScreenProps) {
  const [log, setLog] = useState<string>();
  const [loading, setLoading] = useState(true);
  const view = useRef<HTMLPreElement>(null);
  const load = async () => {
    setLoading(true);
    try { setLog(newestFirst(await bridge.readFullLog())); }
    catch (error) { setLog(undefined); notify(`The log couldn't be read. Does refreshing help? (${describeError(error)})`); }
    finally { setLoading(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(await bridge.readFullLog() || "The log is empty."); notify("Log copied."); }
    catch (error) { notify(`The log couldn't be copied. Does retrying help? (${describeError(error)})`); }
  };
  const openFolder = () => bridge.openLogFolder().catch((error) => notify(`The log folder couldn't be opened. Does it still exist? (${describeError(error)})`));
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (view.current) view.current.scrollTop = 0; }, [log]);

  return <Screen title="Logs" actions={<IconButton label="Back to settings" onClick={() => navigate("/settings")}><ArrowLeft /></IconButton>} toolbar={<>
    <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void load()} disabled={loading}>{loading ? <Spinner /> : <RefreshCw />}Refresh</Button>
    <Button variant="outline" size="sm" aria-label="Copy log" onClick={() => void copy()}><Copy />Copy</Button>
    <Button variant="outline" size="sm" onClick={() => void openFolder()} disabled={!state.logsPath} title={state.logsPath || undefined}><FolderOpen />Open folder</Button>
  </>}>
    <pre ref={view} tabIndex={0} aria-label="Logs, newest first" className="h-0 min-h-40 flex-1 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">{log || (loading ? "" : "The log is empty.")}</pre>
  </Screen>;
}
