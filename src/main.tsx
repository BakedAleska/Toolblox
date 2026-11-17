import React from "react";
import ReactDOM from "react-dom/client";
import App, { PopoutApp } from "./App";
import { describeError, popoutWidgetId, writeLog } from "./bridge";
import { CrashScreen, ErrorBoundary, showEmergencyFallback } from "./ErrorBoundary";

const root = document.getElementById("root") as HTMLElement;

/** Errors that reach the window are logged, and an empty window gets a reload prompt. */
window.addEventListener("error", (event) => {
  void writeLog("error", `Uncaught error: ${describeError(event.error ?? event.message)}`);
  window.setTimeout(() => showEmergencyFallback(root, event.error ?? event.message), 0);
});
window.addEventListener("unhandledrejection", (event) => void writeLog("error", `Unhandled rejection: ${describeError(event.reason)}`));

/** A window labelled `popout-<id>` shows only that widget. */
const popout = popoutWidgetId();

ReactDOM.createRoot(root, {
  onUncaughtError: (error) => window.setTimeout(() => showEmergencyFallback(root, error), 0),
}).render(
  <React.StrictMode>
    <ErrorBoundary scope="window" fallback={(error) => <CrashScreen error={error} />}>
      {popout ? <PopoutApp widgetId={popout} /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
