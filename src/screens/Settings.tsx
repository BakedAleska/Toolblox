import { ExternalLink, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { bridge, isDemo, previewUpdater } from "@/bridge";
import { cn } from "@/lib/utils";
import { ChoiceRow, Panel, Screen, SectionTitle, Spinner, SwitchRow, type ScreenProps } from "@/shared";

type Tab = "general" | "accounts";

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-2"><SectionTitle>{title}</SectionTitle>{children}</section>;
}

export function SettingsScreen({ state, patchSettings }: ScreenProps) {
  const [tab, setTab] = useState<Tab>("general");
  const [checking, setChecking] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const { settings } = state;
  const checkUpdates = async () => {
    setChecking(true); setUpdateStatus("Checking for updates…");
    try { await bridge.checkForUpdates(); setUpdateStatus("Up to date."); }
    catch (error) { setUpdateStatus(`The update check failed. Is the connection working? (${String(error)})`); }
    finally { setChecking(false); }
  };

  return <Screen title="Settings">
    <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-4">
      <TabsList className="bg-transparent p-0">
        <TabsTrigger value="general" className="flex-none px-3">General</TabsTrigger>
        <TabsTrigger value="accounts" className="flex-none px-3">Accounts</TabsTrigger>
      </TabsList>

      <TabsContent value="general" className="flex flex-col gap-4">
        <Group title="Appearance"><Panel className="divide-y">
          <ChoiceRow title="Theme" value={settings.themeMode} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} change={(value) => void patchSettings("themeMode", value)} />
          <ChoiceRow title="Sidebar position" value={settings.sidebarPosition} options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }]} change={(value) => void patchSettings("sidebarPosition", value)} />
        </Panel></Group>
        <Group title="Window"><Panel className="divide-y">
          <SwitchRow title="Launch at startup" description="Start Toolblox when you sign in to this device." checked={settings.openOnLaunch} change={(value) => void patchSettings("openOnLaunch", value)} />
          <SwitchRow title="Run in background" description={`Closing the window keeps Toolblox running in the ${state.platform === "macos" ? "menu bar" : "system tray"}.`} checked={settings.runInBackground} change={(value) => void patchSettings("runInBackground", value)} />
          <SwitchRow title="Always on top" description="Keep this window above other windows." checked={settings.alwaysOnTop} change={(value) => void patchSettings("alwaysOnTop", value)} />
        </Panel></Group>
        <Group title="About"><Panel className="divide-y">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div className="min-w-48 flex-1">
              <p className="text-sm font-medium">Updates</p>
              <p className={cn("text-xs", updateStatus.includes("failed") ? "text-destructive" : "text-muted-foreground")} role="status">{updateStatus || `Version ${state.version}. Updates are checked at every launch.`}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void checkUpdates()} disabled={checking}>{checking ? <Spinner /> : <RefreshCw />}Check now</Button>
            {isDemo() && <div className="flex w-full gap-2 border-t pt-3">
              <span className="mr-auto self-center text-xs text-muted-foreground">Demo previews</span>
              <Button variant="ghost" size="sm" onClick={() => previewUpdater("update")}>Update</Button>
              <Button variant="ghost" size="sm" onClick={() => previewUpdater("failure")}>Failure</Button>
            </div>}
          </div>
          <div className="space-y-1 px-4 py-3">
            <p className="text-sm font-medium">Privacy</p>
            <p className="text-xs text-muted-foreground">Accounts, notes, settings, and widget data are stored on this device. Roblox sessions are protected by {state.platform === "macos" ? "the macOS login Keychain" : "Windows Credential Manager"}. No telemetry is collected.</p>
            <Button variant="link" size="sm" className="h-auto px-0" onClick={() => void bridge.openExternal("https://github.com/BakedAleska/Toolblox/blob/main/SECURITY.md")}>Security policy<ExternalLink /></Button>
          </div>
        </Panel></Group>
      </TabsContent>

      <TabsContent value="accounts" className="flex flex-col gap-4">
        <Group title="List"><Panel className="divide-y">
          <ChoiceRow title="Sort order" value={settings.sortOrder} options={[{ value: "last_played", label: "Last played" }, { value: "alphabetical", label: "A–Z" }, { value: "manual", label: "Manual" }]} change={(value) => void patchSettings("sortOrder", value)} />
          <SwitchRow title="Show avatars" description="Display account avatars in lists." checked={settings.showAvatars} change={(value) => void patchSettings("showAvatars", value)} />
          <SwitchRow title="Compact list" description="Hide notes and reduce row height." checked={settings.compactMode} change={(value) => void patchSettings("compactMode", value)} />
          <SwitchRow title="Game details" description="Show the game name and place ID for accounts in game. Disabling this reduces requests to Roblox." checked={settings.showGameNames} change={(value) => void patchSettings("showGameNames", value)} />
        </Panel></Group>
        <Group title="Joining"><Panel className="divide-y">
          <SwitchRow title="Minimize on join" description="Minimize Toolblox after a manual join." checked={settings.minimizeOnJoin} change={(value) => void patchSettings("minimizeOnJoin", value)} />
          {state.platform === "windows" && <SwitchRow title="Multiple instances" description="Allow several Roblox clients to run at the same time." checked={settings.multiInstance} change={(value) => void patchSettings("multiInstance", value)} />}
        </Panel></Group>
        <Group title="Disconnects"><Panel className="divide-y">
          <SwitchRow title="Auto-rejoin" description="Rejoin accounts that leave a game. Pauses after repeated failures until the account is joined manually." checked={settings.autoRejoin} change={(value) => void patchSettings("autoRejoin", value)} />
          <SwitchRow title="Disconnect notifications" description="Notify when an account leaves a game or auto-rejoin pauses." checked={settings.notifyOnDrop} change={(value) => void patchSettings("notifyOnDrop", value)} />
        </Panel></Group>
      </TabsContent>

    </Tabs>
  </Screen>;
}
