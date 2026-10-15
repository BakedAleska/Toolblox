import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { describeError, writeLog } from "./bridge";

window.addEventListener("error", (event) => void writeLog("error", `Uncaught error: ${describeError(event.error ?? event.message)}`));
window.addEventListener("unhandledrejection", (event) => void writeLog("error", `Unhandled rejection: ${describeError(event.reason)}`));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
