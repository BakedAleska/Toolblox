import { Power, PowerOff, Settings as SettingsIcon, Trash2 } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { bridge } from "@/bridge";
import type { ScreenProps } from "@/shared";
import { useWidgetRegistry } from "@/widgets/host";
import type { WidgetSummary } from "@/types";

export type WidgetAction = { id: "settings" | "toggle" | "uninstall"; label: string; icon: ReactNode; danger?: boolean; run: () => void };
/** Runs a widget action, refreshes the app, and reports a failure with `message`. */
export type WidgetRunner = (widgetId: string, action: () => Promise<void>, message: string) => Promise<void>;

/** Whether a widget has a tab in Settings: its own settings, or a note that it's in its own window. */
export function useWidgetHasSettings(state: ScreenProps["state"]) {
  const { settingsPages } = useWidgetRegistry();
  return (widget: WidgetSummary) => widget.enabled && !state.safeMode
    && (widget.hasSettings || settingsPages.has(widget.id) || state.popouts.includes(widget.id));
}

/** Settings, enable or disable, and uninstall, as every widget menu lists them. */
export function useWidgetActions({ state, navigate, confirm }: Pick<ScreenProps, "state" | "navigate" | "confirm">, run: WidgetRunner) {
  const hasSettings = useWidgetHasSettings(state);
  return (widget: WidgetSummary): WidgetAction[] => [
    ...(hasSettings(widget) ? [{ id: "settings" as const, label: "Settings", icon: <SettingsIcon />, run: () => navigate(`/widgets/${widget.id}/settings`) }] : []),
    {
      id: "toggle", label: widget.enabled ? "Disable" : "Enable", icon: widget.enabled ? <PowerOff /> : <Power />,
      run: () => void run(widget.id, () => bridge.setWidgetEnabled(widget.id, !widget.enabled), `${widget.name} couldn't be ${widget.enabled ? "disabled" : "enabled"}.`),
    },
    {
      id: "uninstall", label: "Uninstall", icon: <Trash2 />, danger: true,
      run: () => confirm({ scale: "small", title: `Uninstall ${widget.name}?`, message: "This removes the widget and its settings from this device.", action: "Uninstall", danger: true, run: () => run(widget.id, () => bridge.uninstallWidget(widget.id), `${widget.name} couldn't be uninstalled.`) }),
    },
  ];
}

function items(actions: WidgetAction[], Item: typeof ContextMenuItem | typeof DropdownMenuItem, Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator) {
  return actions.map((action) => <Fragment key={action.id}>
    {action.danger && <Separator />}
    <Item variant={action.danger ? "destructive" : "default"} onClick={action.run}>{action.icon}{action.label}</Item>
  </Fragment>);
}

/** Opens the widget's actions when `children` is right-clicked. */
export function WidgetContextMenu({ actions, children }: { actions: WidgetAction[]; children: ReactNode }) {
  return <ContextMenu>
    <ContextMenuTrigger className="contents">{children}</ContextMenuTrigger>
    <ContextMenuContent className="min-w-40">{items(actions, ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
  </ContextMenu>;
}

/** The widget's actions as dropdown menu items. */
export function WidgetMenuItems({ actions }: { actions: WidgetAction[] }) {
  return <>{items(actions, DropdownMenuItem, DropdownMenuSeparator)}</>;
}
