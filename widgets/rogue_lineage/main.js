/**
 * Rogue Lineage. The page has one tab per feature, listed in `TABS` inside `activate`.
 *
 * One native helper in `optional-bin/` serves every feature. It reads the screen, draws the
 * overlays, and runs while any feature is on. This module edits and stores the settings. Source for
 * the helper is in `helper/`. The helper is Windows only.
 *
 * Mana bar overlay: reads the mana bar, and marks each spell's range inside it.
 * Cooldown overlay: reads each hotbar slot's skill, and shades a skill's slot while it cools down.
 * Automation: snap training and blacksmithing, each started and stopped by its key in Roblox. These
 * are the only features that send input, and only while Roblox is focused. A label over the Roblox
 * window shows a task while it runs. Both follow the Rogue
 * Lineage Assist Tool's methods.
 *
 * Backpack: the helper also sees when the backpack is open. This module shares that on the
 * `autoclicker.pause` topic as `[{ id, label, active }]`, which the Autoclicker widget offers as a
 * reason to pause. It watches for the backpack while any widget lists `rogue_lineage:backpack`
 * on `autoclicker.pause.watch`, even with both overlays off.
 * The skills it knows are in `skills.js`.
 */

/**
 * Spells by the mana percentage they're cast at. `color` is the range's color on the overlay, which
 * the helper shades when it's close to the mana color.
 */
const SPELLS = [
  { id: "gate", name: "Gate", min: 75, max: 85, color: "3b82f6" },
  { id: "ignis", name: "Ignis", min: 45, max: 55, color: "f97316" },
  { id: "snarvindur", name: "Snarvindur", min: 10, max: 35, color: "22d3ee" },
];
/**
 * Spells with a snap variant, which snap training can train. Training casts the spell itself, so
 * `min` and `max` are the spell's own range, not its snap range. `name` is the spell as the hotbar
 * shows it, and `meaning` is its English name. From the Rogue Lineage Wiki's Spells page. Snap
 * Percutiens, Snap Cane, and Snap Snowman are left out, as their spells' ranges aren't known.
 */
const SNAP_SPELLS = [
  { name: "Armis", meaning: "Weapons", min: 30, max: 60 },
  { name: "Celeritas", meaning: "Speed", min: 75, max: 95 },
  { name: "Gelidus", meaning: "Ice", min: 80, max: 90 },
  { name: "Hystericus", meaning: "Hysteria", min: 75, max: 85 },
  { name: "Ignis", meaning: "Fire", min: 85, max: 95 },
  { name: "Sagitta Sol", meaning: "Sun Arrow", min: 50, max: 60 },
  { name: "Snarvindur", meaning: "Push", min: 55, max: 75 },
  { name: "Telorum", meaning: "Missile", min: 80, max: 90 },
  { name: "Velo", meaning: "Veil", min: 50, max: 100 },
  { name: "Viribus", meaning: "Strength", min: 15, max: 30 },
  { name: "Contrarium", meaning: "Reverse", min: 60, max: 100, god: true },
  { name: "Fimbulvetr", meaning: "Great Winter", min: 90, max: 98, god: true },
  { name: "Hoppa", meaning: "Jump", min: 30, max: 60, god: true },
  { name: "Manus Dei", meaning: "God's Hands", min: 95, max: 97, god: true },
  { name: "Nocere", meaning: "Hurt", min: 70, max: 80, god: true },
];
const DEFAULTS = { enabled: false, tracked: [], colors: {}, debug: false, cooldowns: { enabled: false, shade: "141416", opacity: 60, countdown: true },
  automation: {
    train: { on: false, spell: null, middle: 60, key: "F3", listen: true },
    smith: { on: false, steps: [], count: 50, anvil: null, hammer: null, key: "F4", delays: { click: 100, pick: 20, before: 250, after: 300 } },
  } };
/**
 * Keys that start and stop a task, and their Windows virtual-key codes. F9 to F12 are left out, as
 * Roblox and Windows use them. The two tasks can't share a key.
 */
const TASK_KEYS = Array.from({ length: 8 }, (_, index) => `F${index + 1}`);
const virtualKey = (key) => 0x70 + TASK_KEYS.indexOf(key);
/** Blacksmith limits. Match `SMITH_STEPS` and `SMITH_CLICKS` in `helper/detect.h`. */
const SMITH_STEPS = 8, SMITH_CLICKS = 10, MAX_COUNT = 9999, MAX_DELAY = 5000;
/** Blacksmith waits, in milliseconds. */
const DELAYS = [
  { id: "click", title: "After an anvil click", description: "Milliseconds before the next item is picked." },
  { id: "pick", title: "After picking an item", description: "Milliseconds before the anvil is clicked." },
  { id: "before", title: "Before the hammer", description: "Milliseconds after the last anvil click." },
  { id: "after", title: "After the hammer", description: "Milliseconds before the next weapon starts." },
];
const IDLE_TASK = { running: false, count: 0, heard: 0, reason: "" };
const IDLE_AUDIO = { state: "off", chimes: 0, casts: 0, error: "" };
/** The levels the helper logs at in debug mode, and the longest line it can send. */
const LOG_LEVELS = ["info", "warn"];
const MAX_LOG_LENGTH = 1000;
const HEX = /^[0-9a-f]{6}$/i;
/** The app's color picker style, as in its theme settings. */
const COLOR_INPUT = "size-7 shrink-0 rounded-lg border border-input bg-transparent p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-moz-color-swatch]:rounded-sm [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0";
/** Delay before a color being dragged in the picker is saved, in milliseconds. */
const COLOR_SAVE_DELAY = 300;
const PROCESS = "manabar-windows";
const IDLE = { state: "off", percent: 0, color: "", hotbar: "off" };
/** The hotbar keys, in slot order. */
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "="];
const SKILL_ID = /^[a-z0-9_-]{1,31}$/;
/** A skill name as the helper accepts it: printable ASCII without quotes, backslashes, colons, or semicolons. */
const SKILL_NAME = /^[ !#-9<-[\]-~]{1,31}$/;
/** Keeps catalogue entries the helper accepts. A bad entry is left out rather than stopping the widget. */
const readSkills = (value) => Array.isArray(value) ? value.filter((skill) => SKILL_ID.test(skill?.id) && SKILL_NAME.test(skill.name)
  && Number.isFinite(skill.cooldown) && skill.cooldown > 0 && skill.cooldown <= 3600) : [];

const range = (spell) => `${spell.min}–${spell.max}%`;
/**
 * A tracked entry is a built-in spell's ID, or a custom spell stored as it was entered. `colors`
 * holds the user's color for built-in spells by ID. It's a preference: `SPELLS` keeps the defaults.
 */
function resolve(entry, colors = {}) {
  if (typeof entry !== "string") return entry;
  const spell = SPELLS.find((item) => item.id === entry);
  return spell && { ...spell, color: colors[entry] ?? spell.color };
}
const readTracked = (value) => Array.isArray(value) ? value.filter((entry, index) => typeof entry === "string" ? resolve(entry) && value.indexOf(entry) === index : entry && typeof entry === "object") : [];
const percent = (value) => Math.min(100, Math.max(0, Math.round(Number(value)) || 0));
/** One range for the helper as "min:max:rrggbb:name". Only this copy is cleaned up, so the range is always drawable. */
function zone(spell) {
  const ends = [percent(spell.min), percent(spell.max)].sort((a, b) => a - b);
  const name = String(spell.name ?? "").replace(/[;"\\\x00-\x1f]/g, "").slice(0, 31) || " ";
  return `${ends[0]}:${ends[1]}:${HEX.test(spell.color) ? spell.color : "a3a3a3"}:${name}`;
}
const whole = (value, low, high, fallback) => Number.isInteger(value) && value >= low && value <= high ? value : fallback;
/** A spot on the Roblox window in ten-thousandths of its size, or `null`. */
const readSpot = (value) => [value?.x, value?.y].every((part) => Number.isInteger(part) && part >= 0 && part <= 10000) ? { x: value.x, y: value.y } : null;

function readAutomation(stored) {
  const fallback = DEFAULTS.automation, train = stored?.train ?? {}, smith = stored?.smith ?? {};
  return {
    train: {
      on: typeof train.on === "boolean" ? train.on : fallback.train.on,
      spell: typeof train.spell === "string" ? train.spell : fallback.train.spell,
      middle: whole(train.middle, 10, 100, fallback.train.middle),
      listen: typeof train.listen === "boolean" ? train.listen : fallback.train.listen,
      key: TASK_KEYS.includes(train.key) ? train.key : fallback.train.key,
    },
    smith: {
      on: typeof smith.on === "boolean" ? smith.on : fallback.smith.on,
      steps: Array.isArray(smith.steps) ? smith.steps.filter((step) => Number.isInteger(step?.slot) && step.slot >= 0 && step.slot < KEYS.length
        && Number.isInteger(step.clicks) && step.clicks >= 1 && step.clicks <= SMITH_CLICKS).slice(0, SMITH_STEPS).map(({ slot, clicks }) => ({ slot, clicks })) : fallback.smith.steps,
      count: whole(smith.count, 1, MAX_COUNT, fallback.smith.count),
      anvil: readSpot(smith.anvil),
      hammer: readSpot(smith.hammer),
      key: TASK_KEYS.includes(smith.key) ? smith.key : fallback.smith.key,
      delays: Object.fromEntries(DELAYS.map(({ id }) => [id, whole(smith.delays?.[id], 0, MAX_DELAY, fallback.smith.delays[id])])),
    },
  };
}

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

/** Keeps stored settings that are valid and fills the rest from the defaults. */
function readConfig(stored) {
  const value = stored && typeof stored === "object" ? stored : {};
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULTS.enabled,
    tracked: readTracked(value.tracked),
    colors: Object.fromEntries(SPELLS.filter((spell) => HEX.test(value.colors?.[spell.id])).map((spell) => [spell.id, value.colors[spell.id].toLowerCase()])),
    debug: typeof value.debug === "boolean" ? value.debug : DEFAULTS.debug,
    cooldowns: readCooldowns(value.cooldowns),
    automation: readAutomation(value.automation),
  };
}

function readCooldowns(stored) {
  const value = stored && typeof stored === "object" ? stored : {}, fallback = DEFAULTS.cooldowns;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : fallback.enabled,
    shade: HEX.test(value.shade) ? value.shade.toLowerCase() : fallback.shade,
    opacity: Number.isInteger(value.opacity) && value.opacity >= 20 && value.opacity <= 90 ? value.opacity : fallback.opacity,
    countdown: typeof value.countdown === "boolean" ? value.countdown : fallback.countdown,
  };
}

export async function activate(toolblox) {
  const { React, ui } = toolblox;
  const { system } = ui;
  const h = React.createElement;
  const use = (store) => React.useSyncExternalStore(store.subscribe, store.get);
  const windows = toolblox.getState().platform === "windows";
  /** Loaded with this module's version tag, so an update never runs with the previous catalogue. */
  const SKILLS = readSkills((await import(new URL(`skills.js${new URL(import.meta.url).search}`, import.meta.url).href)).default);

  const config = createStore(readConfig(await toolblox.storage.get().catch(() => undefined)));
  const helper = createStore({ status: "stopped", supported: true });
  const reading = createStore(IDLE);
  /** Whether a cooldown has started since the helper started, which the Cooldowns guide checks off. */
  const cooled = createStore(false);
  /** The hotbar as the helper last read it. `train` is the slot holding snap training's spell, or -1. */
  const EMPTY_HOTBAR = { slots: [], names: [], selected: -1, reader: true, small: false, train: -1 };
  const hotbar = createStore(EMPTY_HOTBAR);

  const backpack = createStore(false);
  /** The state of each automation task as the helper last reported it, and the spot waiting for a click. */
  const tasks = createStore({ train: IDLE_TASK, smith: IDLE_TASK });
  const picking = createStore("");
  /** Game sound as the helper last reported it: whether it listens, and what it has heard. */
  const audio = createStore(IDLE_AUDIO);

  /** Shares whether the backpack is open, for widgets that pause while it is. Toolblox 0.4.6 can't share. */
  const share = toolblox.share;
  const condition = `${toolblox.widget.id}:backpack`;
  const watched = () => share?.get("autoclicker.pause.watch").some(({ value }) => Array.isArray(value) && value.includes(condition)) ?? false;
  const publish = () => share?.set("autoclicker.pause", [{ id: "backpack", label: "Pause when backpack is open", active: backpack.get() }]);
  const setBackpack = (open) => { if (backpack.get() !== open) { backpack.set(open); publish(); } };
  publish();

  const stopped = () => { helper.set({ ...helper.get(), status: "stopped" }); reading.set(IDLE); hotbar.set(EMPTY_HOTBAR); setBackpack(false); tasks.set({ train: IDLE_TASK, smith: IDLE_TASK }); picking.set(""); audio.set(IDLE_AUDIO); cooled.set(false); };
  const running = () => config.get().enabled || config.get().cooldowns.enabled || watched() || config.get().automation.train.on || config.get().automation.smith.on;

  /**
   * Helper log lines waiting to be written, by level. They're written once a second, as the app
   * limits how many requests a widget sends each second.
   */
  const logs = { info: [], warn: [] };
  const flushLogs = () => { for (const level of LOG_LEVELS) if (logs[level].length) void toolblox.log[level](logs[level].splice(0).join("\n")); };

  function handle(events) {
    for (const event of events) {
      if (event.processId !== PROCESS || event.stream !== "stdout") continue;
      let message;
      try { message = JSON.parse(event.line); } catch { void toolblox.log.warn(`Ignored helper output that isn't JSON: ${event.line.slice(0, 200)}`); continue; }
      if (message?.type === "ready") {
        const error = Number(message.error) || 0, build = Number(message.build) || 0;
        helper.set({ status: "running", supported: message.supported === true, error, build, blank: false });
        if (message.supported === false) void toolblox.log.warn(`The Rogue Lineage helper found no way to read Roblox: error ${error} on Windows build ${build}.`);
        else void toolblox.log.info(`The Rogue Lineage helper reads Roblox through ${{ graphics: "Windows.Graphics.Capture", screen: "the screen", print: "PrintWindow" }[message.capture] ?? "the screen"} on Windows build ${build}.`);
      } else if (message?.type === "capture") {
        helper.set({ ...helper.get(), blank: message.blank === true });
      } else if (message?.type === "status") {
        reading.set({ state: String(message.state), percent: Number(message.percent) || 0, color: /^[0-9a-f]{6}$/.test(message.color) ? message.color : "", hotbar: String(message.hotbar ?? "off") });
      } else if (message?.type === "hotbar") {
        const list = (value) => Array.isArray(value) ? value.slice(0, KEYS.length).map(String) : [];
        hotbar.set({ slots: list(message.slots), names: list(message.names), selected: Number.isInteger(message.selected) ? message.selected : -1, reader: message.reader !== false, small: message.small === true,
          train: Number.isInteger(message.train) && message.train < KEYS.length ? message.train : -1 });
      } else if (message?.type === "log" && LOG_LEVELS.includes(message.level) && typeof message.message === "string") {
        logs[message.level].push(message.message.slice(0, MAX_LOG_LENGTH));
      } else if (message?.type === "backpack") {
        setBackpack(message.open === true);
      } else if (message?.type === "automation" && (message.task === "train" || message.task === "smith")) {
        tasks.set({ ...tasks.get(), [message.task]: { running: message.running === true, count: Number(message.count) || 0, heard: Number(message.heard) || 0, reason: typeof message.reason === "string" ? message.reason.slice(0, 100) : "" } });
      } else if (message?.type === "audio" && ["off", "starting", "listening", "failed"].includes(message.state)) {
        audio.set({ state: message.state, chimes: Number(message.chimes) || 0, casts: Number(message.casts) || 0, error: /^[0-9a-f]{8}$/.test(message.error) ? message.error : "" });
      } else if (message?.type === "spot" && (message.spot === "anvil" || message.spot === "hammer")) {
        picking.set("");
        const spot = readSpot({ x: message.x, y: message.y });
        if (spot) saveAutomation("smith", { [message.spot]: spot });
      } else if (message?.type === "cooldown") {
        cooled.set(true);
      }
    }
  }

  async function poll() {
    try { handle((await toolblox.request("process.poll")).events); }
    catch (error) { void toolblox.log.warn(`Polling the Rogue Lineage helper failed: ${error}`); }
  }

  async function send(message) {
    try {
      handle((await toolblox.request("process.send", { processId: PROCESS, message })).events);
      return true;
    } catch (error) {
      if (String(error).includes("too quickly")) {
        void toolblox.log.warn(`A message to the Rogue Lineage helper was dropped by the app's request limit: ${message.type}.`);
        return false;
      }
      stopped();
      toolblox.notify(`The Rogue Lineage helper isn't responding. Can the overlay be turned on again? (${error})`, "error");
      return false;
    }
  }

  const configure = () => {
    const { enabled, tracked, colors, debug, cooldowns, automation: { train, smith } } = config.get();
    const zones = tracked.map((entry) => zone(resolve(entry, colors))).join(";");
    const spell = trainingSpells().find((item) => item.name === train.spell);
    const ends = spell ? [percent(spell.min), percent(spell.max)].sort((a, b) => a - b) : [0, 0];
    return send({ type: "configure", enabled, zones,
      cooldowns: cooldowns.enabled, shade: cooldowns.shade, shadeOpacity: cooldowns.opacity, countdown: cooldowns.countdown, debug, backpack: watched(),
      train: train.on, trainKey: virtualKey(train.key), trainName: spell ? String(spell.name).replace(/[^ -~]|["\\]/g, "").slice(0, 31) : "", trainMin: ends[0], trainMax: ends[1], trainMiddle: train.middle, listen: train.listen,
      smith: smith.on, smithKey: virtualKey(smith.key), smithSteps: smith.steps.map((step) => `${step.slot}:${step.clicks}`).join(";"), smithCount: smith.count,
      anvilX: smith.anvil?.x ?? -1, anvilY: smith.anvil?.y ?? -1, hammerX: smith.hammer?.x ?? -1, hammerY: smith.hammer?.y ?? -1,
      smithClick: smith.delays.click, smithPick: smith.delays.pick, smithBefore: smith.delays.before, smithAfter: smith.delays.after });
  };

  /** Starts the helper, or adopts it after a reload, then sends every setting. Automatic restarts log failures instead of notifying. */
  async function startHelper(automatic = false) {
    helper.set({ ...helper.get(), status: "starting" });
    try {
      await toolblox.request("process.spawn", { processId: PROCESS });
    } catch (error) {
      if (!String(error).includes("already running")) {
        stopped();
        const message = `The Rogue Lineage helper didn't start. Is the package complete? (${error})`;
        if (automatic) void toolblox.log.warn(message); else toolblox.notify(message, "error");
        return;
      }
    }
    if (!await send({ type: "describe" })) return;
    if (!await send({ type: "skills", value: SKILLS.map((skill) => `${skill.id}:${skill.name}:${Math.round(skill.cooldown * 1000)}`).join(";") })) return;
    await configure();
  }

  /**
   * The helper runs only while an overlay is on or another widget watches the backpack, so nothing
   * reads the screen otherwise.
   */
  async function apply() {
    if (!windows) return;
    if (!running()) {
      /* Stopping kills the helper, so a running task is stopped first and given time to let go of the keys it holds. */
      if (helper.get().status === "running" && (tasks.get().train.running || tasks.get().smith.running)) {
        await configure();
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await toolblox.request("process.stop", { processId: PROCESS }).catch((error) => toolblox.log.warn(`Stopping the Rogue Lineage helper failed: ${error}`));
      stopped();
    } else if (helper.get().status === "running") {
      await configure();
    } else if (helper.get().status === "stopped") {
      await startHelper();
    }
  }

  /**
   * Why the helper can't read Roblox, from the Windows build and the error it reported. The helper
   * tries Windows.Graphics.Capture, the screen, and PrintWindow before it reports this.
   */
  function unsupported() {
    const { error, build } = helper.get();
    return `Windows${build ? ` build ${build}` : ""} gave no way to read the Roblox window (error ${error}). Is Toolblox running over Remote Desktop or in a virtual machine?`;
  }
  /** Shown while the helper reads the Roblox window but gets only black from it. */
  const BLANK = "The Roblox window reads as black. Does restarting Roblox help?";

  function save(changes) {
    config.set({ ...config.get(), ...changes });
    void toolblox.storage.set(config.get()).catch((error) => toolblox.notify(`Rogue Lineage settings weren't saved. Does retrying help? (${error})`, "error"));
    void apply();
  }
  const saveAutomation = (part, changes) => save({ automation: { ...config.get().automation, [part]: { ...config.get().automation[part], ...changes } } });
  /** Spells snap training can use: the spells with a snap variant, and the custom spells on the mana bar overlay. */
  const trainingSpells = () => [...SNAP_SPELLS, ...config.get().tracked.filter((entry) => typeof entry !== "string").map((spell) => ({ ...spell, custom: true }))];
  /** Whether the spell picker is open in place of the tabs. */
  const choosing = createStore(false);

  /**
   * Polls the helper every 250 ms while it runs, or every 100 ms while another widget watches the
   * backpack, and restarts it if it exits while it's needed. The app allows a widget 30 requests a
   * second, so polling leaves room for settings and logs.
   */
  let lastStart = Date.now(), ticks = 0, wasWatched = watched();
  const interval = setInterval(() => {
    const { status } = helper.get();
    if (++ticks % 20 === 0) flushLogs();
    if (status !== "stopped") { if (ticks % (watched() ? 2 : 5) === 0) void poll(); }
    else if (windows && running() && Date.now() - lastStart > 5_000) { lastStart = Date.now(); void startHelper(true); }
  }, 50);
  const stopWatching = share?.subscribe(() => { if (watched() !== wasWatched) { wasWatched = watched(); void apply(); } });
  cleanup = () => { clearInterval(interval); stopWatching?.(); flushLogs(); };

  const Swatch = ({ color }) => h("span", { className: "size-2 shrink-0 rounded-full", style: { backgroundColor: `#${color}` }, "aria-hidden": "true" });
  /**
   * A mana bar drawn like the one in game: `bands` are ranges as { min, max, color, strong }, where
   * `color` is a spell's hex color and `strong` marks the part that's used, and `percent` marks the
   * mana read, or is null. Its scale sits below it.
   */
  function Gauge({ label, bands, percent }) {
    const at = (value) => `${Math.min(100, Math.max(0, value))}%`;
    return h("div", { className: "flex flex-col gap-1" },
      h("div", { className: "rl-gauge", role: "img", "aria-label": label },
        percent !== null && h("span", { className: "rl-gauge-fill", style: { width: at(percent) } }),
        bands.map((band, index) => h("span", { key: index, className: ui.cn("rl-gauge-band", band.strong && "rl-gauge-strong"),
          style: { left: at(band.min), width: at(band.max - band.min), ...(band.color ? { backgroundColor: `#${band.color}` } : null) } })),
        percent !== null && h("span", { className: "rl-gauge-mark", style: { left: at(percent) } })),
      h("div", { className: "flex justify-between font-mono text-2xs text-muted-foreground tabular-nums", "aria-hidden": "true" },
        [0, 25, 50, 75, 100].map((value) => h("span", { key: value }, value))));
  }

  const Unavailable = () => h(ui.Panel, { className: "p-4" }, h("p", { className: "text-sm text-muted-foreground" }, "Rogue Lineage overlays aren't available on macOS yet."));
  const Check = () => h("svg", { viewBox: "0 0 16 16", className: "size-3", fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
    h("path", { d: "M3.5 8.5l3 3 6-7" }));

  /**
   * How to use a feature, folded into one line under its console: the next step left to do, or
   * "Set up" once every step is done. Opening it shows what the feature does and every step, each
   * checked off once it's done. `about` says what the feature does, in a sentence or two.
   */
  function Guide({ about, steps }) {
    const next = steps.findIndex((step) => !step.done && !step.optional);
    return h("details", { className: "rl-guide" },
      h("summary", { className: "flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-xs text-muted-foreground" },
        h("svg", { viewBox: "0 0 16 16", className: "rl-guide-arrow size-3 shrink-0", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
          h("path", { d: "M6 4l4 4-4 4" })),
        h("span", { className: "shrink-0 font-medium text-foreground" }, "How to use"),
        h("span", { className: "min-w-0 truncate" }, next >= 0 ? `Next: ${steps[next].text}` : "Set up")),
      h("div", { className: "flex flex-col gap-3 px-2 pt-2 pb-1" },
        h("p", { className: "text-sm text-muted-foreground" }, about),
        h("ol", { className: "flex flex-col gap-2" }, steps.map((step, index) => h("li", { key: index, className: "flex items-start gap-2", "aria-current": index === next ? "step" : undefined },
          h("span", { className: ui.cn("mt-px grid size-5 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums",
            step.done ? "bg-success/15 text-success" : index === next ? "bg-background text-foreground ring-1 ring-ring" : "bg-muted text-muted-foreground") },
            step.done ? h(Check) : index + 1),
          h("span", { className: ui.cn("min-w-0 text-sm", step.done ? "text-muted-foreground" : index === next ? "font-medium" : undefined) },
            step.optional && h("span", { className: "text-muted-foreground" }, "Optional: "), step.text,
            step.done && h("span", { className: "sr-only" }, " Done.")))))));
  }


  /** The mana bar overlay's state, with the percentage it reads. See `FeatureConsole` for the fields. */
  function useManaState() {
    const { enabled } = use(config);
    const { status, supported, blank } = use(helper);
    const { state, percent, color } = use(reading);
    const tracking = enabled && status === "running" && supported && state === "tracking";
    const label = !enabled ? "Off" : status === "starting" ? "Starting" : status === "stopped" ? "Stopped" : !supported ? "Not supported"
      : tracking ? "Tracking" : state === "searching" ? "Looking for the mana bar" : "Waiting for Roblox";
    const detail = !enabled ? "Shows mana as a percentage over the mana bar."
      : status === "running" && !supported ? unsupported()
      : tracking ? (color ? h("span", { className: "flex items-center gap-2" }, h(Swatch, { color }), "Mana color read from the bar") : "Mana color is read on the first charge.")
      : blank ? BLANK
      : state === "searching" ? "Found once the bar is on screen and less than three quarters full."
      : "Starts when Roblox is focused.";
    return { status: label, tone: tracking ? "success" : enabled && supported ? "warning" : "muted", value: tracking ? `${percent}%` : "—", detail,
      on: enabled, attention: enabled && !tracking, power: "Mana bar overlay", disabled: status === "starting", toggle: () => save({ enabled: !enabled }) };
  }

  /**
   * A feature's power button, status, readout, and detail. `state` adds to the console's props
   * `on`, `toggle`, `power` (the power button's label), and `attention`, set while the feature is on
   * but can't work yet.
   */
  const FeatureConsole = ({ state }) => h(system.Console, { ...state,
    control: h(system.PowerButton, { on: state.on, label: state.power, disabled: state.disabled, onClick: state.toggle }) });
  const Status = () => h(FeatureConsole, { state: useManaState() });

  /** A color picker that shows the color while it's dragged and saves it once it settles. */
  function ColorInput({ color, label, change }) {
    const [picked, setPicked] = React.useState(null);
    const timer = React.useRef(0);
    const pick = (value) => {
      setPicked(value);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { change(value.slice(1)); setPicked(null); }, COLOR_SAVE_DELAY);
    };
    return h("input", { type: "color", value: picked ?? `#${color}`, "aria-label": label, className: COLOR_INPUT, onChange: (event) => pick(event.target.value) });
  }

  /**
   * The spells whose ranges are drawn inside the mana bar. The add menu lists the built-in spells
   * that aren't tracked yet, and a custom spell, which is stored exactly as entered. Each row's
   * color can be changed. A built-in spell keeps its default, and **Reset** returns to it.
   */
  function Spells() {
    const { tracked, colors } = use(config);
    const [draft, setDraft] = React.useState(null);
    const add = (entry) => save({ tracked: [...config.get().tracked, entry] });
    const field = (key, label, props) => h(ui.Input, { value: draft[key], "aria-label": label, placeholder: label, onChange: (event) => setDraft({ ...draft, [key]: event.target.value }), ...props });
    const addCustom = () => { add({ name: draft.name, min: Number(draft.min) || 0, max: Number(draft.max) || 0, color: draft.color.replace("#", "") }); setDraft(null); };
    const menu = h(ui.DropdownMenu, null,
      h(ui.DropdownMenuTrigger, { render: h(system.AddButton, null) }, "Add spell"),
      h(ui.DropdownMenuContent, { align: "end", className: "min-w-40" },
        SPELLS.filter((spell) => !tracked.includes(spell.id)).map((spell) => h(ui.DropdownMenuItem, { key: spell.id, onClick: () => add(spell.id) },
          h(Swatch, { color: colors[spell.id] ?? spell.color }), spell.name, h("span", { className: "text-xs text-muted-foreground" }, range(spell)))),
        h(ui.DropdownMenuItem, { onClick: () => setDraft({ name: "", min: "", max: "", color: "#22c55e" }) }, "Custom spell…")));
    const { state, percent: mana } = use(reading);
    const shown = tracked.map((entry) => resolve(entry, colors));
    return h(system.Tile, { label: "Spell ranges", wide: true, action: !draft && menu },
      h(Gauge, { label: state === "tracking" ? `Mana at ${mana}%, with ${shown.length} spell ranges` : `${shown.length} spell ranges`,
        bands: shown.map((spell) => ({ min: Math.min(spell.min, spell.max), max: Math.max(spell.min, spell.max), color: HEX.test(spell.color) ? spell.color : null })),
        percent: state === "tracking" ? mana : null }),
      h("div", null,
      tracked.map((entry, index) => {
        const spell = resolve(entry, colors), builtIn = typeof entry === "string";
        const setColor = (color) => builtIn ? save({ colors: { ...config.get().colors, [entry]: color } })
          : save({ tracked: config.get().tracked.map((other, position) => position === index ? { ...other, color } : other) });
        const reset = () => save({ colors: Object.fromEntries(Object.entries(config.get().colors).filter(([id]) => id !== entry)) });
        return h(system.TileRow, { key: index, actions: h(React.Fragment, null,
          builtIn && entry in colors && h(ui.Button, { variant: "ghost", size: "sm", "aria-label": `Reset ${spell.name} color`, onClick: reset }, "Reset"),
          h(system.RemoveButton, { label: `Remove ${spell.name}`, onClick: () => save({ tracked: config.get().tracked.filter((_, other) => other !== index) }) })) },
          h(ColorInput, { color: spell.color, label: `${spell.name} color`, change: setColor }),
          h("span", { className: "truncate text-sm font-medium" }, spell.name),
          h("span", { className: "shrink-0 text-xs text-muted-foreground" }, range(spell)));
      }),
      draft && h(system.TileRow, { actions: h("input", { type: "color", value: draft.color, "aria-label": "Color", className: COLOR_INPUT, onChange: (event) => setDraft({ ...draft, color: event.target.value }) }) },
        field("name", "Spell name", { className: "h-8 min-w-0 flex-1 bg-background", autoFocus: true })),
      draft && h(system.TileRow, { actions: h(React.Fragment, null,
        h(ui.Button, { variant: "outline", size: "sm", onClick: () => setDraft(null) }, "Cancel"),
        h(ui.Button, { size: "sm", onClick: addCustom }, "Add")) },
        field("min", "From %", { type: "number", inputMode: "numeric", className: "h-8 w-24 bg-background" }),
        field("max", "To %", { type: "number", inputMode: "numeric", className: "h-8 w-24 bg-background" })),
      !draft && !tracked.length && h(system.TileRow, null, h("p", { className: "text-sm text-muted-foreground" }, "No spells. Add the spells you cast to mark their ranges on the bar."))));
  }

  function ManaGuide() {
    const { enabled, tracked } = use(config);
    const { state } = use(reading);
    return h(Guide, { about: "Shows your mana as a percentage above the mana bar, and marks the range each spell needs inside it.", steps: [
      { text: "Turn on the overlay with the power button.", done: enabled },
      { text: "Click into Roblox. The bar is found once your mana is below three quarters.", done: enabled && state === "tracking" },
      { text: "Add the spells you cast under Spell ranges.", done: tracked.length > 0 },
    ] });
  }

  function ManaBar() {
    if (!windows) return h(Unavailable);
    return h(system.Split, { start: h(React.Fragment, null, h(Status), h(ManaGuide)), end: h(Spells) });
  }

  const saveCooldowns = (changes) => save({ cooldowns: { ...config.get().cooldowns, ...changes } });
  const skillById = (id) => SKILLS.find((skill) => skill.id === id);

  /** The cooldown overlay's state, with how many hotbar slots hold a supported skill. */
  function useCooldownState() {
    const { enabled } = use(config).cooldowns;
    const { status, supported, blank } = use(helper);
    const { hotbar: state } = use(reading);
    const { slots, reader, small } = use(hotbar);
    const tracking = enabled && status === "running" && supported && state === "tracking";
    const known = slots.filter((id) => skillById(id)).length;
    const label = !enabled ? "Off" : status === "starting" ? "Starting" : status === "stopped" ? "Stopped" : !supported ? "Not supported"
      : tracking ? "Tracking" : state === "searching" ? "Looking for the hotbar" : "Waiting for Roblox";
    const detail = !enabled ? "Shades a skill's hotbar slot while it cools down."
      : status === "running" && !supported ? unsupported()
      : tracking && !reader ? "Skill names couldn't be read. Is an OCR language installed in Windows settings?"
      : tracking && small ? "The hotbar is too small to read every skill name. Can the Roblox window be larger?"
      : tracking ? `${known === 1 ? "1 supported skill" : `${known} supported skills`} in ${slots.length} slots`
      : blank ? BLANK
      : state === "searching" ? "Found once the hotbar is on screen."
      : "Starts when Roblox is focused.";
    return { status: label, tone: tracking ? "success" : enabled && supported ? "warning" : "muted", value: tracking ? `${known}/${slots.length}` : "—", detail,
      on: enabled, attention: enabled && !tracking, power: "Cooldown overlay", disabled: status === "starting", toggle: () => saveCooldowns({ enabled: !enabled }) };
  }
  const CooldownStatus = () => h(FeatureConsole, { state: useCooldownState() });

  /**
   * Each slot the helper reads, with its key and whether it's selected. A supported skill shows its
   * cooldown. Any other slot shows the name read from it, which is the name to add to `skills.js`.
   */
  function Hotbar() {
    const { slots, names, selected } = use(hotbar);
    const { hotbar: state } = use(reading);
    if (state !== "tracking" || !slots.length) return h(system.Tile, { label: "Hotbar" }, h("p", { className: "text-sm text-muted-foreground" }, "Read from the screen while Roblox is focused."));
    return h(system.Tile, { label: "Hotbar" }, h("ul", { className: "grid grid-cols-3 gap-1" },
      slots.map((id, index) => {
        const skill = skillById(id), current = index === selected;
        const text = skill ? skill.name : !id ? "Empty" : names[index] || "Reading…";
        return h("li", { key: index, "aria-current": current || undefined, className: ui.cn("flex min-w-0 items-center gap-2 rounded-lg p-1", current && "bg-background ring-1 ring-ring") },
          h(system.Keycap, null, KEYS[index]),
          h("span", { className: ui.cn("min-w-0 flex-1 truncate text-sm", skill ? "font-medium" : "text-muted-foreground"), title: skill || !names[index] ? undefined : `${names[index]}: not supported` }, text,
            !skill && id && names[index] && h("span", { className: "sr-only" }, ", not supported")),
          skill && h("span", { className: "shrink-0 font-mono text-xs text-muted-foreground tabular-nums" }, `${skill.cooldown} s`),
          current && h("span", { className: "sr-only" }, "Selected"));
      })));
  }

  const skillRow = (skill) => h(system.TileRow, { key: skill.id, actions: h("span", { className: "font-mono text-xs text-muted-foreground tabular-nums" }, `${skill.cooldown} s`) },
    h("span", { className: "truncate text-sm font-medium" }, skill.name));

  /**
   * The skills in `skills.js`, with their cooldowns. The tile fills the space left on the page and
   * fades out where the list is cut off. **Show all** opens the whole list in a dialog.
   */
  function Supported() {
    const [open, setOpen] = React.useState(false);
    if (!SKILLS.length) return h(system.Tile, { label: "Supported skills" }, h("p", { className: "text-sm text-muted-foreground" }, "No supported skills"));
    return h(system.Tile, { label: "Supported skills", action: h(ui.Button, { variant: "outline", size: "sm", onClick: () => setOpen(true) }, "Show all") },
      h("p", { className: "text-xs text-muted-foreground" }, `Only these ${SKILLS.length} skills are shaded. Other slots show the name read from them.`),
      h("div", { className: "relative min-h-24 flex-1" },
        h("div", { className: "absolute inset-0 overflow-hidden mask-b-from-70%", "aria-hidden": "true" }, SKILLS.map(skillRow))),
      h(ui.Modal, { open, close: () => setOpen(false), size: "portrait", title: "Supported skills", description: "Skills the cooldown overlay shades.", action: "Done", submit: () => setOpen(false) },
        h("div", { className: "min-h-0 flex-1 overflow-y-auto" }, SKILLS.map(skillRow))));
  }

  function CooldownGuide() {
    const { enabled } = use(config).cooldowns;
    const { hotbar: state } = use(reading);
    const used = use(cooled);
    return h(Guide, { about: "Shades a skill's hotbar slot while it cools down, with the seconds left. Skills in an open backpack are shaded too.", steps: [
      { text: "Turn on the overlay with the power button.", done: enabled },
      { text: "Click into Roblox. The hotbar and the skill in each slot are read from the screen.", done: enabled && state === "tracking" },
      { text: "Press a skill's key and click to use it. Its slot is shaded until it's ready.", done: enabled && used },
    ] });
  }

  function Cooldowns() {
    if (!windows) return h(Unavailable);
    return h(system.Split, { start: h(React.Fragment, null, h(CooldownStatus), h(CooldownGuide)), end: h(React.Fragment, null, h(Hotbar), h(Supported)) });
  }

  /** A menu of choices, from a select button that shows the current one. */
  const Choice = ({ label, current, options, pick, className = "w-32" }) => h(ui.DropdownMenu, null,
    h(ui.DropdownMenuTrigger, { render: h(system.SelectButton, { className, "aria-label": `${label}: ${current}` }) }, current),
    h(ui.DropdownMenuContent, { align: "end", className: "max-h-72 min-w-40" },
      options.map((option) => h(ui.DropdownMenuItem, { key: option.value, onClick: () => pick(option.value) }, option.label))));
  const keyOptions = KEYS.map((key, index) => ({ value: index, label: `Key ${key}` }));
  /** Task keys free for `part`: every key but the other task's. */
  const taskKeyOptions = (part) => TASK_KEYS.filter((key) => key !== config.get().automation[part === "train" ? "smith" : "train"].key).map((key) => ({ value: key, label: key }));
  const Row = ({ label, children }) => h(system.TileRow, { actions: children }, h("span", { className: "truncate text-sm font-medium" }, label));

  /** The first setup step a task still needs, as an instruction, or an empty string. */
  function missing(part) {
    const settings = config.get().automation[part];
    if (part === "train") {
      return !trainingSpells().some((spell) => spell.name === settings.spell) ? "Choose a spell to train."
        : hotbar.get().train < 0 ? `Put ${settings.spell} on the hotbar.` : "";
    }
    return !settings.steps.length ? "Add a step for each item." : !settings.anvil ? "Set where the anvil is." : !settings.hammer ? "Set where the hammer is." : "";
  }

  /** Each task's power label, running status, and readout. `idle` describes the task while it's off. */
  const TASKS = {
    train: { label: "Snap training", verb: "Training", idle: "Casts a spell and puts it away before the cast finishes, to train it.",
      value: (state) => state.running || state.count ? String(state.count) : "—" },
    smith: { label: "Blacksmithing", verb: "Smithing", idle: "Picks each item, clicks the anvil, and then the hammer, for each weapon.",
      value: (state, settings) => state.running || state.count ? `${state.count}/${settings.count}` : "—" },
  };

  /** One task's state and progress. */
  function useTaskState(part) {
    const { label, verb, idle, value } = TASKS[part];
    use(hotbar);
    const settings = use(config).automation[part];
    const { status, supported } = use(helper);
    const state = use(tasks)[part];
    const ready = settings.on && status === "running" && supported;
    const needs = missing(part);
    const text = !settings.on ? "Off" : status === "starting" ? "Starting" : status === "stopped" ? "Stopped" : !supported ? "Not supported" : state.running ? verb : needs ? "Needs setup" : "Ready";
    const detail = !settings.on ? idle
      : status === "running" && !supported ? unsupported()
      : !ready ? "Starts when the helper is running."
      : state.running ? `Press ${settings.key} in Roblox to stop.`
      : needs ? needs
      : state.reason && state.reason !== "stopped" ? `Stopped because ${state.reason}. Press ${settings.key} in Roblox to start again.`
      : `Press ${settings.key} in Roblox to start.`;
    return { status: text, tone: state.running ? "success" : ready ? "warning" : "muted", value: value(state, settings), detail,
      on: settings.on, attention: settings.on && !state.running && (!ready || !!needs), power: label, disabled: status === "starting",
      toggle: () => saveAutomation(part, { on: !settings.on }) };
  }
  const TaskStatus = ({ part }) => h(FeatureConsole, { state: useTaskState(part) });

  /** The spell's range and the middle of it that snap training casts in, as `train_band` in `helper/detect.c` works it out. */
  function TrainingGauge({ spell, middle }) {
    const { state, percent: mana } = use(reading);
    const low = Math.min(spell.min, spell.max), high = Math.max(spell.min, spell.max);
    const trim = (high - low) * (1 - middle / 100) / 2;
    let from = low + trim, to = high - trim;
    if (to - from < 3) { const center = (low + high) / 2; from = center - 1.5; to = center + 1.5; }
    return h(Gauge, { label: `${spell.name}'s range ${range(spell)}, cast from ${Math.round(from)} to ${Math.round(to)}%`,
      bands: [{ min: low, max: high }, { min: from, max: to, strong: true }], percent: state === "tracking" ? mana : null });
  }

  /** A spell's name in the picker and setup: its snap variant's name, or a custom spell's own. */
  const snapName = (spell) => spell.custom ? spell.name : `Snap ${spell.name}`;

  /**
   * The spell snap training casts, the hotbar key it's found on, and the key that starts and stops
   * it. The spell is chosen on its own page, and its key is read from the hotbar.
   */
  function Training() {
    const { train } = use(config).automation;
    const { train: slot } = use(hotbar);
    const { hotbar: state } = use(reading);
    const spell = trainingSpells().find((item) => item.name === train.spell);
    const found = !spell ? "Choose a spell first." : slot >= 0 ? `${spell.name} is on key ${KEYS[slot]}.`
      : !train.on ? "Read from the hotbar while snap training is on." : state === "tracking" ? `${spell.name} isn't on the hotbar.` : "Read once the hotbar is on screen.";
    return h(system.Tile, { label: "Setup", wide: true }, h("div", null,
      h(system.TileRow, { actions: h(system.SelectButton, { className: "w-44", "aria-label": `Spell: ${spell ? snapName(spell) : "none"}`, onClick: () => choosing.set(true) }, spell ? snapName(spell) : "Choose spell") },
        h("span", { className: "flex min-w-0 flex-col" },
          h("span", { className: "text-sm font-medium" }, "Spell"),
          h("span", { className: "truncate text-xs text-muted-foreground" }, spell ? `Trains at ${spell.name}'s ${range(spell)}` : "None chosen"))),
      spell && h("div", { className: "border-t border-foreground/8 py-3" }, h(TrainingGauge, { spell, middle: train.middle })),
      h(system.TileRow, { actions: slot >= 0 && h(system.Keycap, null, KEYS[slot]) },
        h("span", { className: "flex min-w-0 flex-col" },
          h("span", { className: "text-sm font-medium" }, "Hotbar key"),
          h("span", { className: "truncate text-xs text-muted-foreground", role: "status" }, found))),
      h(Row, { label: "Start and stop key" }, h(Choice, { label: "Start and stop key", current: train.key, options: taskKeyOptions("train"), pick: (key) => saveAutomation("train", { key }) })),
      h(GameSound)));
  }

  /** What game sound has heard while snap training is on. */
  function GameSound() {
    const { train } = use(config).automation;
    const { state, chimes, casts, error } = use(audio);
    const detail = !train.listen ? "Off in Settings"
      : state === "listening" ? `${chimes === 1 ? "1 mana-full chime" : `${chimes} mana-full chimes`}, ${casts === 1 ? "1 cast" : `${casts} casts`} heard`
      : state === "starting" ? "Starting"
      : state === "failed" ? `Couldn't listen (error ${error}). Is Windows 10 version 2004 or later installed?`
      : train.on ? "Starts when Roblox is focused." : "Listens while snap training is on.";
    return h(system.TileRow, null, h("span", { className: "flex min-w-0 flex-col" },
      h("span", { className: "text-sm font-medium" }, "Game sound"),
      h("span", { className: "truncate text-xs text-muted-foreground", role: "status" }, detail)));
  }

  /** Sets a spot on the Roblox window from the next left click in it. */
  function Spot({ id, label }) {
    const { smith } = use(config).automation;
    const current = use(picking);
    const { status } = use(helper);
    const spot = smith[id];
    const pick = (value) => { picking.set(value); void send({ type: "pick", spot: value }); };
    return h(system.TileRow, { actions: current === id
      ? h(ui.Button, { variant: "outline", size: "sm", onClick: () => pick("") }, "Cancel")
      : h(ui.Button, { variant: "outline", size: "sm", disabled: status !== "running" || !!current, onClick: () => pick(id) }, spot ? "Change" : "Set") },
      h("span", { className: "flex min-w-0 flex-col" },
        h("span", { className: "text-sm font-medium" }, label),
        h("span", { className: "truncate text-xs text-muted-foreground", role: current === id ? "status" : undefined },
          current === id ? `Click the ${label.toLowerCase()} in Roblox.` : spot ? `${(spot.x / 100).toFixed(1)}% across, ${(spot.y / 100).toFixed(1)}% down` : status === "running" ? "Not set" : "Turn on blacksmithing to set.")));
  }

  /** The items blacksmithing picks, how often it clicks the anvil with each, and where the anvil and hammer are. */
  function Smithing() {
    const { smith } = use(config).automation;
    const setSteps = (steps) => saveAutomation("smith", { steps });
    const clickOptions = Array.from({ length: SMITH_CLICKS }, (_, index) => ({ value: index + 1, label: index ? `${index + 1} clicks` : "1 click" }));
    return h(system.Tile, { label: "Setup", wide: true,
      action: h(system.AddButton, { disabled: smith.steps.length >= SMITH_STEPS, onClick: () => setSteps([...smith.steps, { slot: 0, clicks: 1 }]) }, "Add step") },
      h("div", null,
        smith.steps.map((step, index) => {
          const change = (changes) => setSteps(smith.steps.map((other, position) => position === index ? { ...other, ...changes } : other));
          return h(system.TileRow, { key: index, actions: h(React.Fragment, null,
            h(Choice, { label: `Step ${index + 1} key`, current: `Key ${KEYS[step.slot]}`, className: "w-24", options: keyOptions, pick: (slot) => change({ slot }) }),
            h(Choice, { label: `Step ${index + 1} anvil clicks`, current: clickOptions[step.clicks - 1].label, className: "w-28", options: clickOptions, pick: (clicks) => change({ clicks }) }),
            h(system.RemoveButton, { label: `Remove step ${index + 1}`, onClick: () => setSteps(smith.steps.filter((_, position) => position !== index)) })) },
            h("span", { className: "truncate text-sm font-medium" }, `Step ${index + 1}`));
        }),
        !smith.steps.length && h(system.TileRow, null, h("p", { className: "text-sm text-muted-foreground" }, "No steps. Add a step for each item the weapon needs.")),
        h(Spot, { id: "anvil", label: "Anvil" }),
        h(Spot, { id: "hammer", label: "Hammer" }),
        h(Row, { label: "Weapons to make" }, h(ui.Input, { type: "number", inputMode: "numeric", min: 1, max: MAX_COUNT, "aria-label": "Weapons to make", className: "h-8 w-24 bg-background",
          defaultValue: smith.count, key: smith.count,
          onBlur: (event) => saveAutomation("smith", { count: Math.min(MAX_COUNT, Math.max(1, Math.round(Number(event.target.value)) || 1)) }) })),
        h(Row, { label: "Start and stop key" }, h(Choice, { label: "Start and stop key", current: smith.key, options: taskKeyOptions("smith"), pick: (key) => saveAutomation("smith", { key }) }))));
  }

  function TrainingGuide() {
    const { train } = use(config).automation;
    const state = use(tasks).train;
    return h(Guide, { about: `Trains a spell by casting it and putting it away before the cast finishes, over and over. It holds G until mana reaches the middle ${train.middle}% of the spell's range, and charges again when mana drops below it. It sends keys and clicks only while Roblox is focused.`, steps: [
      { text: "Choose the spell to train under Setup.", done: trainingSpells().some((spell) => spell.name === train.spell) },
      { text: "Turn on snap training with the power button.", done: train.on },
      { text: "Put the spell on your hotbar. Its key is found from the hotbar.", done: use(hotbar).train >= 0 },
      { text: `Click into Roblox and press ${train.key} to start. Press it again, or switch windows, to stop.`, done: state.running || state.count > 0 },
    ] });
  }

  function SnapTraining() {
    if (!windows) return h(Unavailable);
    return h(system.Split, {
      start: h(React.Fragment, null,
        h(TaskStatus, { part: "train" }),
        h(TrainingGuide)),
      end: h(Training) });
  }

  function SmithGuide() {
    const { smith } = use(config).automation;
    const state = use(tasks).smith;
    return h(Guide, { about: "Makes weapons at the anvil. For each weapon it picks each item from the hotbar and clicks the anvil, then clicks the hammer. It stops when a step's hotbar slot is empty, and sends keys and clicks only while Roblox is focused.", steps: [
      { text: "Add a step for each item the weapon needs, with its hotbar key and how many times to click the anvil.", done: smith.steps.length > 0 },
      { text: "Turn on blacksmithing with the power button.", done: smith.on },
      { text: "Select Set beside Anvil and Hammer, then click each one in Roblox.", done: !!smith.anvil && !!smith.hammer },
      { text: `Stand at the anvil in Roblox and press ${smith.key} to start. Press it again, or switch windows, to stop.`, done: state.running || state.count > 0 },
    ] });
  }

  function Blacksmith() {
    if (!windows) return h(Unavailable);
    return h(system.Split, {
      start: h(React.Fragment, null,
        h(TaskStatus, { part: "smith" }),
        h(SmithGuide)),
      end: h(Smithing) });
  }

  /**
   * The page's tabs, in order, in two groups: passive features read the screen and draw over it, and
   * active ones send keys and clicks. Each feature of the widget adds one entry, with the hook that
   * reports its state.
   */
  const TABS = [{ id: "mana-bar", label: "Mana bar", group: "passive", Component: ManaBar, useState: useManaState },
    { id: "cooldowns", label: "Cooldowns", group: "passive", Component: Cooldowns, useState: useCooldownState },
    { id: "snap-training", label: "Snap training", group: "active", Component: SnapTraining, useState: () => useTaskState("train") },
    { id: "blacksmith", label: "Blacksmith", group: "active", Component: Blacksmith, useState: () => useTaskState("smith") }];
  /**
   * The tabs as one tinted strip, in the style of the consoles below it. A hairline sets the active
   * features apart. The gauge draws a mana bar. The app's compiled Tailwind lacks these classes, and
   * unlayered rules override the tab's own.
   */
  toolblox.addStyles(`
    .rl-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; width: 100%; height: auto; padding: 4px;
      border-radius: var(--radius-2xl); background: color-mix(in oklab, var(--muted) 60%, transparent); }
    @container (min-width: 42rem) {
      .rl-tabs { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .rl-tab[data-split] { margin-left: 8px; }
      .rl-tab[data-split]::before { content: ""; position: absolute; left: -6px; top: 8px; bottom: 8px; width: 1px;
        background: color-mix(in oklab, var(--foreground) 12%, transparent); }
    }
    .rl-tab { height: auto; min-height: 40px; min-width: 0; flex-direction: column; align-items: flex-start; justify-content: center; gap: 0;
      padding: 4px 12px; border: 0; border-radius: var(--radius-xl); background: transparent; color: var(--muted-foreground); text-align: left; }
    .rl-tab:hover { background: color-mix(in oklab, var(--background) 50%, transparent); }
    .rl-tab[data-active] { background: var(--background); color: var(--foreground); }
    .rl-tab[data-active]:not(:focus-visible) { box-shadow: 0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent); }
    .rl-dot { width: 8px; height: 8px; flex-shrink: 0; border-radius: 9999px; box-shadow: inset 0 0 0 1.5px var(--muted-foreground); }
    .rl-dot[data-tone="success"] { background: var(--success); box-shadow: none; }
    .rl-dot[data-tone="warning"] { background: var(--warning); box-shadow: none; }
    .rl-dot[data-tone="on"] { background: var(--foreground); box-shadow: none; }
    .rl-guide > summary { cursor: pointer; list-style: none; outline: none; }
    .rl-guide > summary::-webkit-details-marker { display: none; }
    .rl-guide > summary:hover { background: color-mix(in oklab, var(--muted) 60%, transparent); }
    .rl-guide > summary:focus-visible { box-shadow: 0 0 0 2px var(--ring); }
    .rl-guide-arrow { transition: rotate 150ms; }
    .rl-guide[open] .rl-guide-arrow { rotate: 90deg; }
    @media (prefers-reduced-motion: reduce) { .rl-guide-arrow { transition: none; } }
    .rl-gauge { position: relative; height: 12px; overflow: hidden; border-radius: 9999px; background: var(--background);
      box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent); }
    .rl-gauge-fill { position: absolute; inset: 0 auto 0 0; background: color-mix(in oklab, var(--foreground) 14%, transparent); }
    .rl-gauge-band { position: absolute; top: 0; bottom: 0; opacity: 0.55; background: color-mix(in oklab, var(--foreground) 18%, transparent); }
    .rl-gauge-strong { opacity: 1; background: color-mix(in oklab, var(--foreground) 45%, transparent); }
    .rl-gauge-mark { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--foreground); }
  `);

  /**
   * A tab named for its feature, after a dot: hollow while it's off, filled while it's on, and in
   * the status colors while it works or needs something. What it needs shows under its name.
   */
  function FeatureTab({ item, split }) {
    const state = item.useState();
    const tone = !state.on ? "off" : state.attention ? "warning" : state.tone === "success" ? "success" : "on";
    const words = { off: "off", warning: state.status, success: state.status, on: "on" }[tone];
    return h(ui.TabsTrigger, { value: item.id, className: "rl-tab", "data-split": split || undefined },
      h("span", { className: "flex max-w-full items-center gap-2" },
        h("span", { className: "rl-dot", "data-tone": tone, "aria-hidden": "true" }),
        h("span", { className: "truncate text-sm font-medium" }, item.label),
        h("span", { className: "sr-only" }, `, ${words}`)),
      state.attention && h("span", { className: "max-w-full truncate pl-4 text-xs text-muted-foreground", "aria-hidden": "true" }, state.status));
  }

  /**
   * The spells snap training can train, as a page in place of the tabs: a search field, then the
   * spells by group. Choosing one returns to the tabs.
   */
  function SpellPicker() {
    const { train } = use(config).automation;
    const [query, setQuery] = React.useState("");
    const close = () => choosing.set(false);
    const pick = (spell) => { saveAutomation("train", { spell: spell.name }); close(); };
    const words = query.trim().toLowerCase();
    const shown = trainingSpells().filter((spell) => !words || `${snapName(spell)} ${spell.meaning ?? ""}`.toLowerCase().includes(words));
    const groups = [{ title: "Snap spells", spells: shown.filter((spell) => !spell.god && !spell.custom) },
      { title: "Snap god spells", spells: shown.filter((spell) => spell.god) },
      { title: "Custom spells", spells: shown.filter((spell) => spell.custom) }].filter((group) => group.spells.length);
    return h("div", { className: "flex flex-1 flex-col gap-4" },
      h("div", { className: "flex items-center gap-2" },
        h(ui.Button, { variant: "outline", size: "sm", onClick: close }, "Back"),
        h(ui.Input, { type: "search", value: query, autoFocus: true, placeholder: "Search spells", "aria-label": "Search spells", className: "h-8 min-w-0 flex-1",
          onChange: (event) => setQuery(event.target.value), onKeyDown: (event) => { if (event.key === "Escape" && !query) close(); } })),
      groups.length ? h("div", { className: "grid items-start gap-4 @5xl:grid-cols-2" }, groups.map((group) =>
        h(ui.Group, { key: group.title, title: group.title }, h(ui.Panel, { className: "divide-y" }, group.spells.map((spell) => {
          const current = spell.name === train.spell;
          return h("button", { key: spell.name, type: "button", "aria-pressed": current, onClick: () => pick(spell),
            className: "flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 motion-reduce:transition-none" },
            h("span", { className: "flex min-w-0 flex-1 flex-col" },
              h("span", { className: "truncate text-sm font-medium" }, snapName(spell)),
              h("span", { className: "truncate text-xs text-muted-foreground" }, spell.custom ? "From the mana bar overlay" : `${spell.meaning}. Trains at ${spell.name}'s range.`)),
            h("span", { className: "shrink-0 font-mono text-xs text-muted-foreground tabular-nums" }, range(spell)),
            h("span", { className: ui.cn("grid size-4 shrink-0 place-items-center", current ? "text-foreground" : "invisible") }, h(Check)),
            current && h("span", { className: "sr-only" }, "Chosen"));
        })))))
        : h("p", { className: "text-sm text-muted-foreground", role: "status" }, `No spells match “${query.trim()}”.`));
  }

  toolblox.registerPage(function RogueLineagePage() {
    const [tab, setTab] = React.useState(TABS[0].id);
    if (use(choosing) && windows) return h(SpellPicker);
    return h(ui.Tabs, { value: tab, onValueChange: setTab, className: "flex-1 gap-2" },
      h(ui.TabsList, { className: "rl-tabs" },
        TABS.map((item, index) => windows ? h(FeatureTab, { key: item.id, item, split: index > 0 && item.group !== TABS[index - 1].group })
          : h(ui.TabsTrigger, { key: item.id, value: item.id, className: "rl-tab" }, item.label))),
      TABS.map((item) => h(ui.TabsContent, { key: item.id, value: item.id, className: "flex flex-col" }, h(item.Component))));
  });

  toolblox.registerSettings(function RogueLineageSettings() {
    const current = use(config);
    if (!windows) return h(Unavailable);
    return h("div", { className: "grid items-start gap-4 @5xl:grid-cols-2" },
      h(ui.Group, { title: "General" }, h(ui.Panel, { className: "divide-y" },
        h(ui.SwitchRow, { title: "Debug mode", description: "Labels what both overlays detect on screen, and logs each step to the Toolblox log.",
          checked: current.debug, change: (debug) => save({ debug }) }))),
      h(ui.Group, { title: "Cooldown overlay" }, h(ui.Panel, { className: "divide-y" },
        h(ui.SettingRow, { title: "Shade color", description: "Covers a slot while its skill cools down.",
          control: () => h(ColorInput, { color: current.cooldowns.shade, label: "Shade color", change: (shade) => saveCooldowns({ shade }) }) }),
        h(ui.SliderRow, { title: "Shade opacity", value: current.cooldowns.opacity, min: 20, max: 90, step: 5, unit: "%", change: (opacity) => saveCooldowns({ opacity }) }),
        h(ui.SwitchRow, { title: "Countdown", description: "Shows the seconds left in the middle of the slot.", checked: current.cooldowns.countdown, change: (countdown) => saveCooldowns({ countdown }) }))),
      h(ui.Group, { title: "Snap training" }, h(ui.Panel, { className: "divide-y" },
        h(ui.SliderRow, { title: "Range used", description: "Casts only in the middle of the spell's range.", value: current.automation.train.middle, min: 10, max: 100, step: 5, unit: "%",
          change: (middle) => saveAutomation("train", { middle }) }),
        h(ui.SwitchRow, { title: "Game sound", description: "Listens to Roblox's sound for the mana-full chime and spell casts. Nothing is recorded or stored.",
          checked: current.automation.train.listen, change: (listen) => saveAutomation("train", { listen }) }))),
      h(ui.Group, { title: "Blacksmith" }, h(ui.Panel, { className: "divide-y" },
        DELAYS.map((delay) => h(ui.SettingRow, { key: delay.id, title: delay.title, description: delay.description,
          control: (labelId, descriptionId) => h(ui.Input, { type: "number", inputMode: "numeric", min: 0, max: MAX_DELAY, "aria-labelledby": labelId, "aria-describedby": descriptionId,
            className: "h-8 w-24", defaultValue: current.automation.smith.delays[delay.id], key: current.automation.smith.delays[delay.id],
            onBlur: (event) => saveAutomation("smith", { delays: { ...config.get().automation.smith.delays, [delay.id]: Math.min(MAX_DELAY, Math.max(0, Math.round(Number(event.target.value)) || 0)) } }) }) })))));
  });

  if (windows && running()) void startHelper();
}

export function deactivate() {
  cleanup();
}
