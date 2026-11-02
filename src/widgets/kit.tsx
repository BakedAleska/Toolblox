import { useEffect, useId, useState, type ComponentProps, type ReactNode } from "react";
import { ChevronDown, Minus, Plus, Power, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The style for system widgets, the tools Toolblox's maintainer publishes. It reads as a control
 * surface rather than an app page: tinted tiles with their label inside, a console with a power
 * button, and monospaced readouts. It uses the same theme tokens as the app. Widgets get it as
 * `toolblox.ui.system`.
 */

/** Status colors for the dot beside a status label. `muted` means idle. */
export type StatusTone = "success" | "warning" | "destructive" | "muted";
const dots: Record<StatusTone, string> = { success: "bg-success", warning: "bg-warning", destructive: "bg-destructive", muted: "bg-muted-foreground" };
const eyebrow = "text-2xs font-semibold tracking-wider text-muted-foreground uppercase";

/**
 * The top of a system widget: a power button or other main control, a status label with a colored
 * dot, a large readout, and a detail line. `stacked` puts the control above the readout and fills
 * the height, for a column in a landscape window.
 */
function Console({ status, tone = "muted", value, detail, control, stacked = false }: { status: string; tone?: StatusTone; value: ReactNode; detail?: ReactNode; control?: ReactNode; stacked?: boolean }) {
  return <section className={cn("flex min-w-0 rounded-2xl bg-muted/60 p-4", stacked ? "h-full flex-col justify-between gap-3" : "items-center gap-4")}>
    {control}
    <div className="min-w-0 flex-1 content-end">
      <p role="status" className={cn("flex items-center gap-2", eyebrow)}><span className={cn("size-2 shrink-0 rounded-full", dots[tone])} aria-hidden="true" />{status}</p>
      <p className="mt-1 truncate font-mono text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {detail && <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>}
    </div>
  </section>;
}

/** A round on and off button. `label` names what it turns on. */
function PowerButton({ on, label, disabled, onClick }: { on: boolean; label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" aria-pressed={on} aria-label={label} disabled={disabled} onClick={onClick}
    className={cn("grid size-14 shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 motion-reduce:transition-none [&_svg]:size-6",
      on ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-card text-foreground ring-1 ring-foreground/10 hover:bg-card/70")}>
    <Power aria-hidden="true" />
  </button>;
}

/** A grid of tiles that adds columns as the page widens. */
function Tiles({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] content-start gap-2", className)}>{children}</div>;
}

/**
 * Two columns that use the width of large pages: they stack below the `@5xl` container width.
 * `landscape` always shows both columns and fills the height, for a landscape window.
 */
function Split({ start, end, landscape = false }: { start: ReactNode; end: ReactNode; landscape?: boolean }) {
  return <div className={cn("grid gap-2", landscape ? "flex-1 grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" : "@5xl:grid-cols-2 @5xl:items-start")}>
    <div className="flex min-w-0 flex-col gap-2">{start}</div>
    <div className="flex min-w-0 flex-col gap-2">{end}</div>
  </div>;
}

/** A tinted tile with its label inside. `wide` spans the whole grid. */
function Tile({ label, action, wide = false, children }: { label: string; action?: ReactNode; wide?: boolean; children: ReactNode }) {
  return <section className={cn("flex min-w-0 flex-col gap-2 rounded-xl bg-muted/60 p-3", wide && "col-span-full")}>
    <div className="flex min-h-7 items-center justify-between gap-2"><h2 className={eyebrow}>{label}</h2>{action}</div>
    {children}
  </section>;
}

/** A row inside a tile: leading content, then trailing controls. Rows in one tile are separated by dividers. */
function TileRow({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return <div className="flex min-h-9 items-center gap-2 border-foreground/8 py-2 first:pt-0 last:pb-0 not-first:border-t">
    <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </div>;
}

/** A tile row with a title, an optional description, and a switch labelled by them. */
function SwitchField({ title, description, checked, change }: { title: string; description?: string; checked: boolean; change: (value: boolean) => void }) {
  const id = useId();
  return <TileRow actions={<Switch checked={checked} onCheckedChange={(value) => change(value)} aria-labelledby={`${id}-t`} aria-describedby={description ? `${id}-d` : undefined} />}>
    <span className="min-w-0">
      <span id={`${id}-t`} className="block text-sm font-medium">{title}</span>
      {description && <span id={`${id}-d`} className="block text-xs text-muted-foreground">{description}</span>}
    </span>
  </TileRow>;
}

/** A tile row with a title, the current value, and a full-width slider below. */
function SliderField({ title, value, min, max, step = 1, unit = "", change }: { title: string; value: number; min: number; max: number; step?: number; unit?: string; change: (value: number) => void }) {
  const id = useId();
  return <div className="flex flex-col gap-2 border-foreground/8 py-2 first:pt-0 last:pb-0 not-first:border-t">
    <div className="flex items-center justify-between gap-2">
      <label htmlFor={id} className="text-sm font-medium">{title}</label>
      <span className="font-mono text-sm tabular-nums" aria-hidden="true">{value}{unit}</span>
    </div>
    <input id={id} type="range" min={min} max={max} step={step} value={value} aria-valuetext={`${value}${unit}`} onChange={(event) => change(Number(event.target.value))}
      className="h-5 w-full cursor-pointer accent-primary outline-none focus-visible:ring-2 focus-visible:ring-ring" />
  </div>;
}

/** A whole number between decrease and increase buttons, filling its tile. Typed values apply on Enter or blur and are clamped to `min` and `max`. */
function Stepper({ label, value, min, max, change }: { label: string; value: number; min: number; max: number; change: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const set = (next: number) => {
    const clamped = Number.isFinite(next) ? Math.min(Math.max(Math.round(next), min), max) : value;
    setDraft(String(clamped));
    if (clamped !== value) change(clamped);
  };
  return <div className="flex items-center gap-2">
    <Button variant="outline" size="icon" aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= min} onClick={() => set(value - 1)}><Minus /></Button>
    <Input type="number" inputMode="numeric" min={min} max={max} step={1} value={draft} aria-label={label} className="h-8 min-w-0 flex-1 bg-background text-center font-mono text-xl font-semibold tabular-nums"
      onChange={(event) => setDraft(event.target.value)} onBlur={() => set(Number(draft))} onKeyDown={(event) => { if (event.key === "Enter") set(Number(draft)); }} />
    <Button variant="outline" size="icon" aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= max} onClick={() => set(value + 1)}><Plus /></Button>
  </div>;
}

/** A single choice as a full-width segmented track. */
function Segmented<T extends string>({ label, value, options, change }: { label: string; value: T; options: { value: T; label: string }[]; change: (value: T) => void }) {
  return <ToggleGroup aria-label={label} size="sm" spacing={1} value={[value]} onValueChange={(values) => { if (values[0]) change(values[0] as T); }} className="w-full rounded-lg bg-background p-1">
    {options.map((option) => <ToggleGroupItem key={option.value} value={option.value} className="flex-1">{option.label}</ToggleGroupItem>)}
  </ToggleGroup>;
}

/** A key or mouse button name, drawn as a key. */
function Keycap({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-lg bg-card px-2 font-mono text-xs font-medium text-foreground ring-1 ring-foreground/10">{children}</kbd>;
}

/** A labelled button that adds an item, with a plus sign. */
function AddButton({ children, ...props }: ComponentProps<typeof Button>) {
  return <Button variant="secondary" size="sm" {...props}><Plus />{children}</Button>;
}

/** An outlined trash button with a tooltip. `label` names what it removes. */
function RemoveButton({ label, ...props }: { label: string } & ComponentProps<typeof Button>) {
  return <Tooltip>
    <TooltipTrigger render={<Button variant="outline" size="icon-sm" aria-label={label} className="text-muted-foreground hover:text-destructive" {...props} />}><Trash2 /></TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>;
}

/** An outlined button with a down arrow that opens a menu of choices. Pass it as the menu trigger's `render`. */
function SelectButton({ children, className, ...props }: ComponentProps<typeof Button>) {
  return <Button variant="outline" size="sm" className={cn("justify-between gap-2", className)} {...props}>{children}<ChevronDown className="text-muted-foreground" /></Button>;
}

export const system = { AddButton, Console, Keycap, PowerButton, RemoveButton, Segmented, SelectButton, SliderField, Split, Stepper, SwitchField, Tile, TileRow, Tiles };
