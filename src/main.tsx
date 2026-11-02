import React from "react";
import ReactDOM from "react-dom/client";
import App, { PopoutApp } from "./App";
import { describeError, popoutWidgetId, writeLog } from "./bridge";

window.addEventListener("error", (event) => void writeLog("error", `Uncaught error: ${describeError(event.error ?? event.message)}`));
window.addEventListener("unhandledrejection", (event) => void writeLog("error", `Unhandled rejection: ${describeError(event.reason)}`));

/** A window labelled `popout-<id>` shows only that widget. */
const popout = popoutWidgetId();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {popout ? <PopoutApp widgetId={popout} /> : <App />}
  </React.StrictMode>,
);
