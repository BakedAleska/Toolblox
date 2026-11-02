/**
 * Autoclicker. A native helper in `optional-bin/` reads keybinds, sends clicks, and draws the
 * on-screen indicator. This module edits and stores the settings. Source for the helper is in
 * `helper/`.
 */
const MODES = [
  { value: "toggle", label: "Toggle", description: "Turns clicking on or off." },
  { value: "enable", label: "Enable", description: "Turns clicking on." },
  { value: "disable", label: "Disable", description: "Turns clicking off." },
  { value: "hold", label: "Hold", description: "Clicks while held." },
];
const DEFAULTS = { cps: 10, button: "left", onlyRoblox: true, position: null, indicator: { transparency: 10, visible: true }, binds: [{ key: "F6", mode: "toggle" }] };
const MAX_BINDS = 16;

/** Keys the helper can bind, by `KeyboardEvent.code`. Matches the table in `helper/clicker.c`. */
const KEYS = new Set([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `Key${letter}`),
  ..."0123456789".split("").map((digit) => `Digit${digit}`),
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  ..."0123456789".split("").map((digit) => `Numpad${digit}`),
  "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash",
  "Space", "Tab", "Enter", "Backspace", "Insert", "Delete", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEnter",
  "Mouse1", "Mouse2", "Mouse3", "Mouse4", "Mouse5",
]);
const SYMBOLS = { Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/" };
const MOUSE = { Mouse1: "Left mouse", Mouse2: "Right mouse", Mouse3: "Middle mouse", Mouse4: "Mouse 4", Mouse5: "Mouse 5" };
/** `MouseEvent.button` to bind names. */
const BUTTONS = ["Mouse1", "Mouse3", "Mouse2", "Mouse4", "Mouse5"];

const keyLabel = (key) => MOUSE[key] ?? SYMBOLS[key] ?? key.replace(/^Key|^Digit/, "").replace(/^Arrow(.+)/, "$1 arrow").replace(/^Numpad(.+)/, "Numpad $1");

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

/** The indicator's saved spot as fractions of the screen, or `null` for the default bottom-left. */
const readPosition = (value) => [value?.x, value?.y].every((part) => typeof part === "number" && part >= 0 && part <= 1) ? { x: value.x, y: value.y } : null;

/** Keeps stored settings that are valid and fills the rest from the defaults. */
function readConfig(stored) {
  const value = stored && typeof stored === "object" ? stored : {};
  const binds = Array.isArray(value.binds) ? value.binds.filter((bind) => KEYS.has(bind?.key) && MODES.some((mode) => mode.value === bind?.mode)) : DEFAULTS.binds;
  return {
    cps: Number.isInteger(value.cps) && value.cps >= 1 ? value.cps : DEFAULTS.cps,
    button: ["right", "middle"].includes(value.button) ? value.button : "left",
    onlyRoblox: typeof value.onlyRoblox === "boolean" ? value.onlyRoblox : DEFAULTS.onlyRoblox,
    position: readPosition(value.position),
    indicator: {
      transparency: Number.isInteger(value.indicator?.transparency) && value.indicator.transparency >= 0 && value.indicator.transparency <= 100 ? value.indicator.transparency : DEFAULTS.indicator.transparency,
      visible: typeof value.indicator?.visible === "boolean" ? value.indicator.visible : DEFAULTS.indicator.visible,
    },
    binds: binds.filter((bind, index) => binds.findIndex((other) => other.key === bind.key) === index).slice(0, MAX_BINDS),
  };
}

export async function activate(toolblox) {
  const { React, ui } = toolblox;
  const h = React.createElement;
  const use = (store) => React.useSyncExternalStore(store.subscribe, store.get);
  const macos = toolblox.getState().platform === "macos";
  const processId = macos ? "clicker-macos" : "clicker-windows";

  const config = createStore(readConfig(await toolblox.storage.get().catch(() => undefined)));
  const helper = createStore({ status: "stopped", maxCps: 0 });
  const clicker = createStore({ state: "off", reason: "", cps: 0, target: 0 });
  const permissions = createStore({ keybinds: true, clicks: true });

  const stopped = () => { helper.set({ ...helper.get(), status: "stopped" }); clicker.set({ state: "off", reason: "", cps: 0, target: 0 }); };

  function handle(events) {
    for (const event of events) {
      if (event.processId !== processId || event.stream !== "stdout") continue;
      let message;
      try { message = JSON.parse(event.line); } catch { void toolblox.log.warn(`Ignored helper output that isn't JSON: ${event.line.slice(0, 200)}`); continue; }
      if (message?.type === "ready") {
        helper.set({ status: "running", maxCps: Number(message.maxCps) || 1 });
        if (config.get().cps > helper.get().maxCps) save({ cps: helper.get().maxCps });
      } else if (message?.type === "status") {
        clicker.set({ state: String(message.state), reason: String(message.reason ?? ""), cps: Number(message.cps) || 0, target: Number(message.target) || 0 });
      } else if (message?.type === "permissions") {
        permissions.set({ keybinds: message.keybinds === true, clicks: message.clicks === true });
      } else if (message?.type === "position") {
        save({ position: readPosition(message) });
      } else if (message?.type === "error") {
        toolblox.notify(String(message.message), "error");
      } else if (message?.type === "bye") {
        stopped();
      }
    }
  }

  async function poll() {
    try { handle((await toolblox.request("process.poll")).events); }
    catch (error) { void toolblox.log.warn(`Polling the autoclicker helper failed: ${error}`); }
  }

  async function send(message) {
    try {
      handle((await toolblox.request("process.send", { processId, message })).events);
      return true;
    } catch (error) {
      stopped();
      toolblox.notify(`The autoclicker helper isn't responding. Can it be started again? (${error})`, "error");
      return false;
    }
  }

  const configure = () => {
    const { cps, button, onlyRoblox, position, indicator } = config.get();
    return send({ type: "configure", cps, button, onlyRoblox, x: position?.x ?? -1, y: position?.y ?? -1, transparency: indicator.transparency, indicator: indicator.visible });
  };
  const sendBinds = () => send({ type: "binds", value: config.get().binds.map((bind) => `${bind.key}:${bind.mode}`).join(",") });

  function save(changes) {
    config.set({ ...config.get(), ...changes });
    void toolblox.storage.set(config.get()).catch((error) => toolblox.notify(`Autoclicker settings weren't saved. Does retrying help? (${error})`, "error"));
  }

  /** Starts the helper, or adopts it after a reload, then sends every setting. Automatic restarts log failures instead of notifying. */
  async function startHelper(automatic = false) {
    helper.set({ ...helper.get(), status: "starting" });
    try {
      await toolblox.request("process.spawn", { processId });
    } catch (error) {
      if (!String(error).includes("already running")) {
        stopped();
        const message = `The autoclicker helper didn't start. Is the package complete? (${error})`;
        if (automatic) void toolblox.log.warn(message); else toolblox.notify(message, "error");
        return;
      }
    }
    if (await send({ type: "describe" }) && await configure()) await sendBinds();
  }

  /** The helper runs while the widget is on. Toolblox stops it when the widget is turned off, and it's restarted here if it exits. */
  let lastStart = Date.now();
  const interval = setInterval(() => {
    const { status } = helper.get();
    if (status === "running") void poll();
    else if (status === "stopped" && Date.now() - lastStart > 5_000) { lastStart = Date.now(); void startHelper(true); }
  }, 250);
  cleanup = () => { clearInterval(interval); };

  const changeConfig = (changes) => { save(changes); if (helper.get().status === "running") void configure(); };

  const BUTTON_OPTIONS = [{ value: "left", label: "Left" }, { value: "middle", label: "Middle" }, { value: "right", label: "Right" }];
  const { system } = ui;

  /** Power, status, and target speed. Turning on starts the helper first when it isn't running. `stacked` fills a landscape column. */
  function Status({ stacked = false }) {
    const { status } = use(helper);
    const { state, cps } = use(clicker);
    const current = use(config);
    const running = status === "running";
    const active = running && state !== "off";
    const toggle = async () => {
      if (active) return void send({ type: "action", action: "disable" });
      if (helper.get().status !== "running") await startHelper();
      if (helper.get().status === "running") await send({ type: "action", action: "enable" });
    };
    const label = status === "starting" ? "Starting" : !running ? "Stopped" : state === "on" ? "Clicking" : state === "paused" ? "Paused outside Roblox" : "Off";
    const tone = !running ? "muted" : state === "on" ? "success" : state === "paused" ? "warning" : "muted";
    const bind = current.binds.find((item) => item.mode === "toggle" || item.mode === "enable" || item.mode === "hold");
    const button = BUTTON_OPTIONS.find((item) => item.value === current.button).label;
    const detail = active ? `${cps} measured · ${button} button`
      : bind ? `${bind.mode === "hold" ? "Hold" : "Press"} ${keyLabel(bind.key)} to start · ${button} button`
      : `${button} button`;
    return h(system.Console, { status: label, tone, value: `${current.cps} CPS`, detail, stacked,
      control: h(system.PowerButton, { on: active, label: "Autoclicker", disabled: status === "starting", onClick: () => void toggle() }) });
  }

  function PermissionsNotice() {
    const { status } = use(helper);
    const { keybinds, clicks } = use(permissions);
    if (status !== "running" || (keybinds && clicks)) return null;
    const missing = [!keybinds && "Input Monitoring", !clicks && "Accessibility"].filter(Boolean).join(" and ");
    return h(system.Tile, { label: "Permissions", wide: true },
      h(system.TileRow, { actions: macos && h(ui.Button, { variant: "outline", size: "sm", onClick: () => void send({ type: "permissions" }) }, "Open System Settings") },
        h("p", { className: "text-sm text-warning", role: "alert" }, macos ? `Toolblox needs ${missing} permission.` : "Windows refused the input hook. Does restarting Toolblox help?")));
  }

  /** Clicks per second, from 1 to the device's measured limit. */
  function Speed() {
    const current = use(config);
    const { maxCps } = use(helper);
    return h(system.Tile, { label: "Clicks per second" },
      h(system.Stepper, { label: "Clicks per second", value: current.cps, min: 1, max: maxCps || current.cps, change: (cps) => changeConfig({ cps }) }));
  }

  /** The mouse button each click presses. */
  function MouseButton() {
    const current = use(config);
    return h(system.Tile, { label: "Mouse button" },
      h(system.Segmented, { label: "Mouse button", value: current.button, options: BUTTON_OPTIONS, change: (button) => changeConfig({ button }) }));
  }

  /** The keybind list. Each row sets its mode or removes it. */
  function Keybinds() {
    const current = use(config);
    const [recording, setRecording] = React.useState(false);
    const update = (binds) => { save({ binds }); if (helper.get().status === "running") void sendBinds(); };
    React.useEffect(() => {
      if (!recording) return;
      const finish = (key) => {
        setRecording(false);
        if (!key) return;
        if (!KEYS.has(key)) return toolblox.notify(`${key} can't be used as a keybind. Does another key work?`, "error");
        const binds = config.get().binds;
        if (binds.some((bind) => bind.key === key)) return toolblox.notify(`${keyLabel(key)} already has a keybind.`);
        update([...binds, { key, mode: "toggle" }]);
      };
      const key = (event) => { event.preventDefault(); event.stopPropagation(); finish(event.code === "Escape" ? undefined : event.code); };
      const mouse = (event) => { event.preventDefault(); event.stopPropagation(); finish(BUTTONS[event.button]); };
      const block = (event) => { event.preventDefault(); event.stopPropagation(); };
      const timer = setTimeout(() => {
        window.addEventListener("keydown", key, true);
        window.addEventListener("mousedown", mouse, true);
        window.addEventListener("auxclick", block, true);
        window.addEventListener("contextmenu", block, true);
      });
      return () => {
        clearTimeout(timer);
        window.removeEventListener("keydown", key, true);
        window.removeEventListener("mousedown", mouse, true);
        setTimeout(() => { window.removeEventListener("auxclick", block, true); window.removeEventListener("contextmenu", block, true); });
      };
    }, [recording]);
    return h(system.Tile, { label: "Keybinds", wide: true, action: !recording && h(system.AddButton, { disabled: current.binds.length >= MAX_BINDS, onClick: () => setRecording(true) }, "Add keybind") },
      h("div", null,
        current.binds.map((bind) => {
          const mode = MODES.find((item) => item.value === bind.mode);
          return h(system.TileRow, { key: bind.key, actions: h(React.Fragment, null,
            h(ui.DropdownMenu, null,
              h(ui.DropdownMenuTrigger, { render: h(system.SelectButton, { className: "w-24", "aria-label": `Mode for ${keyLabel(bind.key)}: ${mode.label}` }) }, mode.label),
              h(ui.DropdownMenuContent, { align: "end", className: "min-w-40" },
                MODES.map((item) => h(ui.DropdownMenuItem, { key: item.value, onClick: () => update(current.binds.map((other) => other.key === bind.key ? { ...other, mode: item.value } : other)) },
                  h("span", { className: "flex flex-col" }, h("span", { className: item.value === bind.mode ? "font-medium" : undefined }, item.label), h("span", { className: "text-xs text-muted-foreground" }, item.description)))))),
            h(system.RemoveButton, { label: `Remove ${keyLabel(bind.key)}`, onClick: () => update(current.binds.filter((other) => other.key !== bind.key)) })) },
            h(system.Keycap, null, keyLabel(bind.key)),
            h("span", { className: "truncate text-xs text-muted-foreground" }, mode.description));
        }),
        recording && h(system.TileRow, { actions: h(ui.Button, { variant: "outline", size: "sm", onClick: () => setRecording(false) }, "Cancel") },
          h("p", { className: "text-sm text-muted-foreground", role: "status" }, "Press a key or mouse button.")),
        !recording && !current.binds.length && h(system.TileRow, null, h("p", { className: "text-sm text-muted-foreground" }, "No keybinds"))));
  }

  toolblox.addToSlot("page.topbar", function Popout() { return h(ui.PopoutButton); });

  /** The main window shows every control. Its own window is landscape and keeps power, speed, and the mouse button. */
  toolblox.registerPage(function AutoclickerPage() {
    const popout = system.usePopout();
    if (popout) return h(system.Split, { landscape: true, start: h(Status, { stacked: true }), end: h(React.Fragment, null, h(PermissionsNotice), h(Speed), h(MouseButton)) });
    return h(system.Split, {
      start: h(React.Fragment, null, h(Status), h(system.Tiles, null, h(Speed), h(MouseButton))),
      end: h(React.Fragment, null, h(PermissionsNotice), h(Keybinds)),
    });
  });

  toolblox.registerSettings(function AutoclickerSettings() {
    const current = use(config);
    const indicator = (changes) => changeConfig({ indicator: { ...config.get().indicator, ...changes } });
    return h(system.Tiles, null,
      h(system.Tile, { label: "Clicking" },
        h(system.SwitchField, { title: "Only in Roblox", description: "Pauses while another window is focused.", checked: current.onlyRoblox, change: (onlyRoblox) => changeConfig({ onlyRoblox }) })),
      h(system.Tile, { label: "Indicator" },
        h(system.SliderField, { title: "Background transparency", value: current.indicator.transparency, min: 0, max: 100, step: 5, unit: "%", change: (transparency) => indicator({ transparency }) }),
        h(system.SwitchField, { title: "Show indicator", description: "Drag it to move it.", checked: current.indicator.visible, change: (visible) => indicator({ visible }) })));
  });

  void startHelper();
}

export function deactivate() {
  cleanup();
}
