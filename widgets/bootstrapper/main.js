/**
 * Bootstrapper. While on, every Roblox client except the focused one runs within a profile's
 * limits: CPU cap, RAM cap, CPU cores, CPU and GPU priority, efficiency mode, and low memory
 * priority. An optional frame rate cap sets Roblox's own Maximum frame rate for every client. With server location on, each join shows where its
 * server is, from the public server address in the Roblox log and a lookup on ipinfo.io. The
 * native helper in `optional-bin/` does the work; its source is in `helper/`.
 */
/** Limits for unfocused clients. cpu is a percentage of the whole CPU (100 for no cap), ram is megabytes (0 for no cap), and cores is how many logical processors a client may use (0 for all). */
const PROFILES = {
  watch: { priority: "below", eco: false, cpu: 50, ram: 0, cores: 0, gpu: "below" },
  background: { priority: "idle", eco: true, cpu: 25, ram: 2048, cores: 4, gpu: "idle" },
  afk: { priority: "idle", eco: true, cpu: 10, ram: 1024, cores: 2, gpu: "idle" },
};
const DEFAULTS = { on: false, capFps: false, fps: 60, profile: "background", custom: PROFILES.background, region: false };
const LIMITS = { cpu: [1, 100], ram: [0, 32768], cores: [0, 64] };
/** Names for the bits the helper reports when Windows refuses a limit. */
const FAILURES = [[1, "priority"], [2, "efficiency mode"], [4, "memory priority"], [8, "CPU cap"], [16, "RAM cap"], [32, "CPU cores"], [64, "GPU priority"]];
const ADDRESS = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const processId = "helper-windows";

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

function readLimits(value) {
  const base = PROFILES.background;
  const limits = value && typeof value === "object" ? value : {};
  const number = (key) => {
    const n = Number(limits[key]);
    return Number.isInteger(n) && n >= LIMITS[key][0] && n <= LIMITS[key][1] ? n : base[key];
  };
  return {
    priority: ["normal", "below", "idle"].includes(limits.priority) ? limits.priority : base.priority,
    eco: typeof limits.eco === "boolean" ? limits.eco : base.eco,
    cpu: number("cpu"), ram: number("ram"), cores: number("cores"),
    gpu: ["normal", "below", "idle"].includes(limits.gpu) ? limits.gpu : base.gpu,
  };
}

function readConfig(stored) {
  const value = stored && typeof stored === "object" ? stored : {};
  const fps = Number(value.fps);
  return {
    on: value.on === true,
    capFps: typeof value.capFps === "boolean" ? value.capFps : DEFAULTS.capFps,
    fps: Number.isInteger(fps) && fps >= 5 && fps <= 240 ? fps : DEFAULTS.fps,
    profile: value.profile in PROFILES || value.profile === "custom" ? value.profile : DEFAULTS.profile,
    custom: readLimits(value.custom),
    region: value.region === true,
  };
}

const limitsOf = (config) => config.profile === "custom" ? config.custom : PROFILES[config.profile];

export async function activate(toolblox) {
  const { React, ui } = toolblox;
  const h = React.createElement;
  const use = (store) => React.useSyncExternalStore(store.subscribe, store.get);
  const windows = toolblox.getState().platform !== "macos";

  const config = createStore(readConfig(await toolblox.storage.get().catch(() => undefined)));
  const helper = createStore({ running: false, clients: 0, limited: 0, capped: false, failed: 0 });

  const locations = new Map();

  /** Looks up a server address on ipinfo.io once and shows where it is. */
  async function showLocation(address) {
    if (!config.get().region || !ADDRESS.test(address)) return;
    if (!locations.has(address)) {
      try {
        const { status, body } = await toolblox.request("network.fetch", { url: `https://ipinfo.io/${address}/json` });
        const info = status === 200 ? JSON.parse(body) : {};
        const parts = [info.city, info.region, info.country].filter((part, index, all) => typeof part === "string" && part && all.indexOf(part) === index);
        if (!parts.length) throw new Error(`ipinfo.io answered with status ${status}`);
        locations.set(address, parts.join(", "));
      } catch (error) {
        void toolblox.log.warn(`The server location wasn't found: ${error}`);
        return;
      }
    }
    void send({ type: "toast", title: "Server location", text: locations.get(address) });
  }

  function handle(events) {
    for (const event of events) {
      if (event.processId !== processId || event.stream !== "stdout") continue;
      let message;
      try { message = JSON.parse(event.line); } catch { void toolblox.log.warn(`Ignored helper output that isn't JSON: ${event.line.slice(0, 200)}`); continue; }
      if (message?.type === "status") helper.set({ running: true, clients: Number(message.clients) || 0, limited: Number(message.limited) || 0, capped: message.capped === true, failed: Number(message.failed) || 0 });
      else if (message?.type === "server") void showLocation(String(message.address));
      else if (message?.type === "error") void toolblox.log.warn(String(message.message));
    }
  }

  async function send(message) {
    try {
      handle((await toolblox.request("process.send", { processId, message })).events);
      return true;
    } catch (error) {
      helper.set({ ...helper.get(), running: false });
      void toolblox.log.warn(`The Bootstrapper helper isn't responding: ${error}`);
      return false;
    }
  }

  function apply(current = config.get()) {
    if (!current.on) return send({ type: "clear" });
    const { priority, eco, cpu, ram, cores, gpu } = limitsOf(current);
    return send({ type: "apply", fps: String(current.capFps ? current.fps : 0), priority, eco: eco ? "on" : "off", cpu: String(cpu), ram: String(ram), cores: String(cores), gpu });
  }

  function save(changes) {
    config.set({ ...config.get(), ...changes });
    void toolblox.storage.set(config.get()).catch((error) => toolblox.notify(`Bootstrapper settings weren't saved. Does retrying help? (${error})`, "error"));
    void apply();
  }

  /** Starts the helper, or adopts it after a reload, then sends the saved settings. */
  async function startHelper() {
    try {
      await toolblox.request("process.spawn", { processId });
    } catch (error) {
      if (!String(error).includes("already running")) { void toolblox.log.warn(`The Bootstrapper helper didn't start: ${error}`); return; }
    }
    if (await apply()) helper.set({ ...helper.get(), running: true });
  }

  if (windows) {
    let lastStart = Date.now();
    const timer = setInterval(() => {
      if (helper.get().running) void toolblox.request("process.poll").then(({ events }) => handle(events), (error) => void toolblox.log.warn(`Polling the Bootstrapper helper failed: ${error}`));
      else if (Date.now() - lastStart > 5_000) { lastStart = Date.now(); void startHelper(); }
    }, 1_000);
    cleanup = () => { clearInterval(timer); void send({ type: "clear" }); };
    void startHelper();
  }

  const Gauge = () => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
    h("path", { d: "m12 14 4-4" }), h("path", { d: "M3.34 19a10 10 0 1 1 17.32 0" }));

  const refused = (failed) => FAILURES.filter(([bit]) => failed & bit).map(([, name]) => name).join(", ");
  const summary = ({ clients, limited, failed }) => clients ? `${limited} of ${clients} Roblox ${clients === 1 ? "client" : "clients"} limited${failed ? `, refused: ${refused(failed)}` : ""}` : "No Roblox clients open";
  const levels = [{ value: "normal", label: "Normal" }, { value: "below", label: "Below normal" }, { value: "idle", label: "Low" }];

  toolblox.addToSlot("accounts.toolbar", function BootstrapperToggle() {
    const current = use(config);
    const state = use(helper);
    if (!windows) return null;
    return h(ui.IconButton, { label: current.on ? `Join with Bootstrapper · ${summary(state)}` : "Join with Bootstrapper", variant: current.on ? "secondary" : "ghost",
      "aria-pressed": current.on, className: current.on ? undefined : "text-muted-foreground", onClick: () => save({ on: !current.on }) }, h(Gauge));
  });

  toolblox.registerPage(function BootstrapperPage() {
    const current = use(config);
    if (!windows) return h(ui.EmptyState, { icon: h(Gauge), title: "Windows only", text: "Priority and efficiency mode are only available on Windows." });
    const state = use(helper);
    const limits = limitsOf(current);
    const custom = current.profile === "custom";
    const tune = (changes) => save({ profile: "custom", custom: { ...limits, ...changes } });
    return h("div", { className: "grid items-start gap-4" },
      h(ui.Group, { title: "Unfocused clients" }, h(ui.Panel, { className: "divide-y" },
        h(ui.ChoiceRow, { title: "Profile", description: "Watch keeps clients you still look at smooth. Background and AFK use less for clients you rarely or never look at.", value: current.profile,
          options: [{ value: "watch", label: "Watch" }, { value: "background", label: "Background" }, { value: "afk", label: "AFK" }, { value: "custom", label: "Custom" }], change: (profile) => save(profile === "custom" ? { profile, custom: limits } : { profile }) }),
        state.failed ? h(ui.SettingRow, { title: "Not applied", description: `Windows refused: ${refused(state.failed)}.`, control: () => null }) : null,
        h(ui.SliderRow, { title: "CPU cap", description: "Hard limit on each client's share of the whole CPU. 100% is no cap. Very low caps can disconnect a client while it loads.", value: limits.cpu, min: 1, max: 100, step: 1, unit: "%", change: (cpu) => tune({ cpu }) }),
        h(ui.SliderRow, { title: "RAM cap", description: "Hard limit on each client's memory in use. 0 is no cap. Anything over it moves to the page file, which can make the client stutter.", value: limits.ram, min: 0, max: 16384, step: 256, unit: " MB", change: (ram) => tune({ ram }) }),
        h(ui.SliderRow, { title: "CPU cores", description: "How many logical processors each client may use, from the last ones. 0 is all.", value: limits.cores, min: 0, max: 32, step: 1, change: (cores) => tune({ cores }) }),
        h(ui.ChoiceRow, { title: "Priority", description: "CPU priority.", value: limits.priority, options: levels, change: (priority) => tune({ priority }) }),
        h(ui.ChoiceRow, { title: "GPU priority", description: "Lets the focused client's frames go first on the graphics card.", value: limits.gpu, options: levels, change: (gpu) => tune({ gpu }) }),
        h(ui.SwitchRow, { title: "Efficiency mode", description: "Runs clients on slower, power-saving CPU scheduling.", checked: limits.eco, change: (eco) => tune({ eco }) }))),
      h(ui.Group, { title: "Every client" }, h(ui.Panel, { className: "divide-y" },
        h(ui.SwitchRow, { title: "Frame rate cap", description: "Sets Roblox's Maximum frame rate for every client opened while on, including the focused one. Your own setting comes back when it's off.", checked: current.capFps, change: (capFps) => save({ capFps }) }),
        current.capFps && h(ui.SliderRow, { title: "Frames per second", description: "Roblox's own menu offers 30, 60, 75, 120, 144, 165, and 240. Other values may be ignored.", value: current.fps, min: 5, max: 240, step: 5, unit: " FPS", change: (fps) => save({ fps }) }))),
      h(ui.Group, { title: "Joins" }, h(ui.Panel, { className: "divide-y" },
        h(ui.SwitchRow, { title: "Server location", description: "Shows the server's city at the top of the screen on each join. Looks up the server's address on ipinfo.io.", checked: current.region, change: (region) => save({ region }) }))));
  });
}

export function deactivate() {
  cleanup();
  cleanup = () => {};
}
