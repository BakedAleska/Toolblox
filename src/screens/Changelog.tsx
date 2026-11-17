import { ArrowLeft, ChevronDown, ScrollText } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { inline, releases, type ChangelogBlock } from "@/changelog";
import { EmptyState, IconButton, Panel, Screen, type ScreenProps } from "@/shared";

/** Set when the next changelog page opens because Toolblox was just updated. */
let openedAfterUpdate = false;
export const showChangelogAfterUpdate = () => { openedAfterUpdate = true; };

function Text({ text }: { text: string }) {
  return inline(text).map((part, index) => part.bold ? <strong key={index} className="font-medium text-foreground">{part.text}</strong>
    : part.italic ? <em key={index}>{part.text}</em> : part.text);
}

function Block({ block }: { block: ChangelogBlock }) {
  if (block.kind === "heading") return block.level === 2
    ? <h2 className="text-sm font-semibold">{block.text}</h2>
    : <h3 className="mt-1 text-sm font-medium">{block.text}</h3>;
  if (block.kind === "text") return <p className="text-sm text-muted-foreground"><Text text={block.text} /></p>;
  return <ul className="grid list-disc gap-1 pl-4 text-sm text-muted-foreground marker:text-muted-foreground/60">
    {block.items.map((item, index) => <li key={index}><Text text={item} /></li>)}
  </ul>;
}

/** Every bundled changelog, one version at a time, opening on the installed version. After an
 * update it's titled "What's new" and continues to the dashboard. */
export function ChangelogScreen({ state, navigate }: ScreenProps) {
  const [afterUpdate] = useState(() => { const value = openedAfterUpdate; openedAfterUpdate = false; return value; });
  const [version, setVersion] = useState(() => (releases.find(({ version }) => version === state.version) ?? releases[0])?.version);
  const release = releases.find((entry) => entry.version === version);
  const back = afterUpdate
    ? <IconButton label="Back to dashboard" onClick={() => navigate("/")}><ArrowLeft /></IconButton>
    : <IconButton label="Back to settings" onClick={() => navigate("/settings")}><ArrowLeft /></IconButton>;

  return <Screen title={afterUpdate ? "What's new" : "Changelog"} actions={back} tools={<>
    {releases.length > 1 && <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="w-36 justify-between font-normal" aria-label={`Version: ${release?.title ?? ""}`} />}>
        <span className="truncate">{release?.title}</span><ChevronDown className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-menu">
        <DropdownMenuRadioGroup value={version} onValueChange={(value) => setVersion(value as string)}>
          {releases.map((entry) => <DropdownMenuRadioItem key={entry.version} value={entry.version}>{entry.title}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>}
    {afterUpdate && <Button size="sm" onClick={() => navigate("/")}>Continue</Button>}
  </>}>
    {!release ? <EmptyState icon={<ScrollText />} title="No changelog" text="This build doesn't include a changelog." /> : <>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Toolblox {release.title}</h2>
        {release.date && <span className="text-xs text-muted-foreground">{release.date}</span>}
        {release.version === state.version && <Badge variant="outline" className="text-muted-foreground">Installed</Badge>}
      </div>
      <div className="grid items-start gap-3 @5xl:grid-cols-2 @[110rem]:grid-cols-3">
        {release.sections.map((section, index) => <Panel key={index} className="grid gap-2 p-4">
          {section.map((block, blockIndex) => <Block key={blockIndex} block={block} />)}
        </Panel>)}
      </div>
    </>}
  </Screen>;
}
