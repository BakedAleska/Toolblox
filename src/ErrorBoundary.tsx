import { Copy, FolderOpen, RotateCcw, ShieldAlert, TriangleAlert } from "lucide-react";
import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { bridge, copyFailureReport, describeError } from "@/bridge";

type BoundaryProps = {
  /** Names what failed in the log, such as `window` or a route. */
  scope: string;
  /** Clears a caught error when it changes, such as on navigation. */
  resetKey?: unknown;
  fallback: (error: string, reset: () => void) => ReactNode;
  children: ReactNode;
};

/** Catches render errors below it, logs them, and shows `fallback` instead of an empty window. */
export class ErrorBoundary extends Component<BoundaryProps, { error?: string; key?: unknown }> {
  state: { error?: string; key?: unknown } = { key: this.props.resetKey };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) }; }
  static getDerivedStateFromProps(props: BoundaryProps, state: { error?: string; key?: unknown }) {
    return props.resetKey === state.key ? null : { error: undefined, key: props.resetKey };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) { void bridge.writeLog("error", `Render failed in ${this.props.scope}: ${describeError(error)}${info.componentStack ?? ""}`); }
  reset = () => this.setState({ error: undefined });
  render() { return this.state.error === undefined ? this.props.children : this.props.fallback(this.state.error, this.reset); }
}

/** Copies the error with the recent log. The label confirms the copy or says it failed, since no toast shows here. */
function CopyLogsButton({ error }: { error: string }) {
  const [label, setLabel] = useState("Copy logs");
  const copy = () => copyFailureReport(error).then(() => setLabel("Logs copied"), () => setLabel("Logs weren't copied"));
  return <Button variant="ghost" size="sm" onClick={() => void copy()} aria-live="polite"><Copy />{label}</Button>;
}

/** Shown in place of a page that failed to render. The sidebar stays usable. */
export function PageError({ error, reset, home }: { error: string; reset: () => void; home: () => void }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
    <TriangleAlert className="size-6 text-destructive" aria-hidden="true" />
    <div className="grid gap-1">
      <h1 className="text-sm font-medium">This page failed to load. Does reloading it help?</h1>
      <p className="max-w-md text-xs break-words text-muted-foreground">{error}</p>
    </div>
    <div className="flex flex-wrap justify-center gap-2">
      <Button variant="outline" size="sm" onClick={reset}><RotateCcw />Reload page</Button>
      <Button variant="ghost" size="sm" onClick={home}>Go to Dashboard</Button>
      <CopyLogsButton error={error} />
      <Button variant="ghost" size="sm" onClick={() => void bridge.openLogFolder()}><FolderOpen />Open log folder</Button>
    </div>
  </div>;
}

/** Shown in place of the whole window when the app shell itself failed to render. */
export function CrashScreen({ error }: { error: string }) {
  return <main className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground" role="alert">
    <TriangleAlert className="size-6 text-destructive" aria-hidden="true" />
    <div className="grid gap-1">
      <h1 className="text-sm font-medium">Toolblox failed to load. Does reloading help?</h1>
      <p className="max-w-md text-xs break-words text-muted-foreground">{error}</p>
    </div>
    <div className="flex flex-wrap justify-center gap-2">
      <Button size="sm" onClick={() => window.location.reload()}><RotateCcw />Reload</Button>
      <Button variant="outline" size="sm" onClick={() => void bridge.restartApp(true).catch(() => window.location.reload())}><ShieldAlert />Restart in safe mode</Button>
      <CopyLogsButton error={error} />
      <Button variant="ghost" size="sm" onClick={() => void bridge.openLogFolder()}><FolderOpen />Open log folder</Button>
    </div>
  </main>;
}

/** Fills an empty root with a plain reload prompt, for failures React can't render past, such as
 * an error inside the crash screen. Uses no React and no imports that could fail. */
export function showEmergencyFallback(root: HTMLElement, error: unknown) {
  if (root.childElementCount > 0) return;
  const main = document.createElement("main");
  main.className = "flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm text-foreground";
  main.setAttribute("role", "alert");
  const title = document.createElement("p");
  title.className = "font-medium";
  title.textContent = "Toolblox failed to load. Does reloading help?";
  const detail = document.createElement("p");
  detail.className = "max-w-md text-xs break-words text-muted-foreground";
  detail.textContent = error instanceof Error ? error.message : String(error);
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "rounded-lg bg-primary px-3 py-1.5 text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => window.location.reload());
  main.append(title, detail, reload);
  root.append(main);
}
