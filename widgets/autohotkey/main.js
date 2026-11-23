/**
 * AutoHotkey. Lists the scripts in a folder and every running AutoHotkey script, and runs, reloads,
 * stops, creates, and edits them. A native helper in `optional-bin/` does the file and window work.
 * Source for the helper is in `helper/`.
 */
const DEFAULTS = { folder: null, editor: "vscode", reloadOnSave: true };
const LIST_EVERY_MS = 1_500;

let cleanup = () => {};

function createStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set: (next) => { value = next; listeners.forEach((listener) => listener()); },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

function readConfig(stored) {
  const value = stored && typeof stored === "object" ? stored : {};
  return {
    folder: typeof value.folder === "string" && value.folder ? value.folder : DEFAULTS.folder,
    editor: value.editor === "default" ? "default" : DEFAULTS.editor,
    reloadOnSave: typeof value.reloadOnSave === "boolean" ? value.reloadOnSave : DEFAULTS.reloadOnSave,
  };
}

const scriptName = (path) => path.split(/[\\/]/).at(-1).replace(/\.ahk$/i, "");
const key = (path) => path.toLowerCase();

export async function activate(toolblox) {
  const { React, ui } = toolblox;
  const h = React.createElement;
  const use = (store) => React.useSyncExternalStore(store.subscribe, store.get);
  const windows = toolblox.getState().platform !== "macos";
  const processId = "helper-windows";

  const config = createStore(readConfig(await toolblox.storage.get().catch(() => undefined)));
  const helper = createStore({ status: "stopped", installed: true, version: "", defaultFolder: "" });
  const scripts = createStore({ loaded: false, files: [], running: [] });
  const folder = () => config.get().folder ?? helper.get().defaultFolder;

  /** Modified times from the previous listing, to reload running scripts whose file changed. */
  let seen = null;
  let pending = { files: [], running: [] };
  /** The folder picker blocks the helper, so listing waits until it closes instead of filling its input. */
  let picking = false;
  const pick = () => { picking = true; void send({ type: "pick", folder: folder() }); };

  function listed() {
    const { files, running } = pending;
    pending = { files: [], running: [] };
    const runningKeys = new Set(running.map(key));
    if (seen && config.get().reloadOnSave) {
      for (const file of files) {
        const before = seen.get(key(file.path));
        if (before !== undefined && file.modified > before && runningKeys.has(key(file.path))) void send({ type: "reload", path: file.path });
      }
    }
    seen = new Map(files.map((file) => [key(file.path), file.modified]));
    scripts.set({ loaded: true, files, running });
  }

  function handle(events) {
    for (const event of events) {
      if (event.processId !== processId || event.stream !== "stdout") continue;
      let message;
      try { message = JSON.parse(event.line); } catch { void toolblox.log.warn(`Ignored helper output that isn't JSON: ${event.line.slice(0, 200)}`); continue; }
      if (message?.type === "ready") { picking = false; helper.set({ status: "running", installed: message.installed === true, version: String(message.version ?? ""), defaultFolder: String(message.folder ?? "") }); }
      else if (message?.type === "script") pending.files.push({ path: String(message.path), modified: Number(message.modified) || 0 });
      else if (message?.type === "running") pending.running.push(String(message.path));
      else if (message?.type === "listed") listed();
      else if (message?.type === "created") { toolblox.notify(`Created ${scriptName(String(message.path))}.`, "success"); void edit(String(message.path)); }
      else if (message?.type === "folder") { picking = false; if (typeof message.path === "string") save({ folder: message.path }); }
      else if (message?.type === "error") toolblox.notify(String(message.message), "error");
    }
  }

  const stopped = () => { picking = false; helper.set({ ...helper.get(), status: "stopped" }); };

  async function send(message) {
    try {
      handle((await toolblox.request("process.send", { processId, message })).events);
      return true;
    } catch (error) {
      stopped();
      toolblox.notify(`The AutoHotkey helper isn't responding. Can it be started again? (${error})`, "error");
      return false;
    }
  }

  const list = () => send({ type: "list", folder: folder() });
  const act = (type, path) => send({ type, path, folder: folder() }).then(() => list());
  const edit = (path) => send({ type: "edit", path, folder: folder(), editor: config.get().editor });

  function save(changes) {
    const folderChanged = "folder" in changes && changes.folder !== config.get().folder;
    config.set({ ...config.get(), ...changes });
    void toolblox.storage.set(config.get()).catch((error) => toolblox.notify(`AutoHotkey settings weren't saved. Does retrying help? (${error})`, "error"));
    if (folderChanged) { seen = null; scripts.set({ loaded: false, files: [], running: [] }); void list(); }
  }

  /** Starts the helper, or adopts it after a reload. Automatic restarts log failures instead of notifying. */
  async function startHelper(automatic = false) {
    helper.set({ ...helper.get(), status: "starting" });
    try {
      await toolblox.request("process.spawn", { processId });
    } catch (error) {
      if (!String(error).includes("already running")) {
        stopped();
        const message = `The AutoHotkey helper didn't start. Is the package complete? (${error})`;
        if (automatic) void toolblox.log.warn(message); else toolblox.notify(message, "error");
        return;
      }
    }
    if (await send({ type: "describe" })) await list();
  }

  if (windows) {
    let lastStart = Date.now();
    let lastList = Date.now();
    const timer = setInterval(() => {
      const { status } = helper.get();
      if (status === "running" && !picking && Date.now() - lastList > LIST_EVERY_MS) { lastList = Date.now(); void list(); }
      else if (status !== "stopped") void toolblox.request("process.poll").then(({ events }) => handle(events), (error) => void toolblox.log.warn(`Polling the AutoHotkey helper failed: ${error}`));
      else if (status === "stopped" && Date.now() - lastStart > 5_000) { lastStart = Date.now(); void startHelper(true); }
    }, 250);
    cleanup = () => clearInterval(timer);
    void startHelper();
  }

  const FileIcon = () => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
    h("path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" }), h("path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }),
    h("path", { d: "M10 12.5 8 15l2 2.5" }), h("path", { d: "m14 12.5 2 2.5-2 2.5" }));

  function ScriptRow({ path, running, external }) {
    const name = scriptName(path);
    return h("div", { className: "flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" },
      h("div", { className: "min-w-0 flex-1 basis-40" },
        h("p", { className: "truncate text-sm font-medium", title: path }, name),
        h("p", { className: "truncate text-xs text-muted-foreground", title: path }, external ? path : running ? "Running" : "Stopped")),
      h("div", { className: "flex items-center gap-2" },
        running && h(ui.Button, { variant: "ghost", size: "sm", onClick: () => void act("reload", path) }, "Reload"),
        h(ui.Button, { variant: "ghost", size: "sm", onClick: () => void edit(path) }, "Edit"),
        h(ui.Button, { variant: running ? "outline" : "default", size: "sm", className: "w-16", "aria-label": `${running ? "Stop" : "Run"} ${name}`, onClick: () => void act(running ? "stop" : "run", path) }, running ? "Stop" : "Run")));
  }

  function NewScript({ open, close }) {
    const [name, setName] = React.useState("");
    React.useEffect(() => { if (open) setName(""); }, [open]);
    return h(ui.Modal, { open, close, size: "portrait", title: "New script", description: `Creates a script in ${folder()}.`, action: "Create", disabled: !name.trim(),
      submit: () => { void send({ type: "create", folder: folder(), name: name.trim() }).then(() => list()); close(); } },
      h(ui.Input, { autoFocus: true, "aria-label": "Script name", placeholder: "Script name", value: name, onChange: (event) => setName(event.target.value) }));
  }

  toolblox.addToSlot("page.topbar", function Popout() { return h(ui.PopoutButton); });

  toolblox.registerPage(function AutoHotkeyPage() {
    const state = use(helper);
    const listing = use(scripts);
    const [creating, setCreating] = React.useState(false);
    if (!windows) return h(ui.EmptyState, { icon: h(FileIcon), title: "Windows only", text: "AutoHotkey runs only on Windows." });
    const runningKeys = new Set(listing.running.map(key));
    const fileKeys = new Set(listing.files.map((file) => key(file.path)));
    const elsewhere = listing.running.filter((path) => !fileKeys.has(key(path)));
    const ready = state.status === "running";
    return h("div", { className: "flex flex-col gap-4" },
      h("div", { className: "flex flex-wrap items-center gap-2" },
        h(ui.Button, { size: "sm", disabled: !ready, onClick: () => setCreating(true) }, "New script"),
        h(ui.Button, { variant: "outline", size: "sm", disabled: !ready || !state.installed, onClick: () => void send({ type: "spy" }) }, "Window Spy"),
        h(ui.Button, { variant: "outline", size: "sm", disabled: !ready, onClick: () => void send({ type: "folder", folder: folder() }) }, "Open folder"),
        h(ui.Button, { variant: "outline", size: "sm", disabled: !ready, onClick: () => void send({ type: "docs" }) }, "Documentation")),
      ready && !state.installed && h(ui.Panel, null, h(ui.SettingRow, { title: "AutoHotkey isn't installed", description: "Scripts need AutoHotkey to run.",
        control: () => h(ui.Button, { size: "sm", onClick: () => void send({ type: "download" }) }, "Download AutoHotkey") })),
      !listing.loaded ? h("div", { className: "flex justify-center py-12" }, h(ui.Spinner))
        : h(ui.Group, { title: "Scripts" }, listing.files.length
          ? h(ui.Panel, { className: "divide-y" }, listing.files.map((file) => h(ScriptRow, { key: file.path, path: file.path, running: runningKeys.has(key(file.path)) })))
          : h(ui.Panel, null, h(ui.EmptyState, { icon: h(FileIcon), title: "No scripts", text: `Scripts in ${folder()} appear here.` }))),
      elsewhere.length > 0 && h(ui.Group, { title: "Running elsewhere" },
        h(ui.Panel, { className: "divide-y" }, elsewhere.map((path) => h(ScriptRow, { key: path, path, running: true, external: true })))),
      h(NewScript, { open: creating, close: () => setCreating(false) }));
  });

  toolblox.registerSettings(function AutoHotkeySettings() {
    const current = use(config);
    const state = use(helper);
    if (!windows) return h(ui.EmptyState, { icon: h(FileIcon), title: "Windows only", text: "AutoHotkey runs only on Windows." });
    return h("div", { className: "grid items-start gap-4 @5xl:grid-cols-2" },
      h(ui.Group, { title: "Scripts" }, h(ui.Panel, { className: "divide-y" },
        h(ui.SettingRow, { title: "Scripts folder", description: folder() || "Documents\\AutoHotkey", control: () => h("div", { className: "flex items-center gap-2" },
          current.folder && h(ui.Button, { variant: "ghost", size: "sm", onClick: () => save({ folder: null }) }, "Reset"),
          h(ui.Button, { variant: "outline", size: "sm", disabled: state.status !== "running", onClick: pick }, "Change")) }),
        h(ui.SwitchRow, { title: "Reload on save", description: "Reloads a running script when its file changes.", checked: current.reloadOnSave, change: (reloadOnSave) => save({ reloadOnSave }) }))),
      h(ui.Group, { title: "Editor" }, h(ui.Panel, { className: "divide-y" },
        h(ui.ChoiceRow, { title: "Open scripts in", value: current.editor, options: [{ value: "vscode", label: "VS Code" }, { value: "default", label: "Default editor" }], change: (editor) => save({ editor }) }))),
      state.version && h("p", { className: "text-xs text-muted-foreground" }, `AutoHotkey ${state.version}`));
  });
}

export function deactivate() {
  cleanup();
}
