/**
 * Rogue Lineage. The page has one tab per feature, listed in `TABS` inside `activate`.
 *
 * One native helper in `optional-bin/` serves every feature. It reads the screen, draws the
 * overlays, and runs while any feature is on. This module edits and stores the settings. Source for
 * the helper is in `helper/`. The helper is Windows only.
 *
 * Mana bar overlay: reads the mana bar, and warns about a Gate cast outside its range.
 * Cooldown overlay: reads each hotbar slot's skill, and shades a skill's slot while it cools down.
 *
 * Backpack: the helper also sees when the backpack is open. This module shares that on the
 * `autoclicker.pause` topic as `[{ id, label, active }]`, which the Autoclicker widget offers as a
 * reason to pause. It watches for the backpack while any widget lists `rogue_lineage:backpack`
 * on `autoclicker.pause.watch`, even with both overlays off.
 * The skills it knows are in `skills.js`.
 */

/**
 * Spells by the mana percentage they're cast at. `color` is the range's color on the overlay, which
 * the helper shades when it's close to the mana color. `warning` marks a spell whose casts the
 * helper can detect, and matches the detection in `helper/manabar.c`.
 */
const SPELLS = [
  { id: "gate", name: "Gate", min: 75, max: 85, color: "3b82f6", warning: true },
  { id: "ignis", name: "Ignis", min: 45, max: 55, color: "f97316" },
  { id: "snarvindur", name: "Snarvindur", min: 10, max: 35, color: "22d3ee" },
];
const DEFAULTS = { enabled: false, tracked: [], colors: {}, warnings: [], sound: true, debug: false, cooldowns: { enabled: false, shade: "141416", opacity: 60, countdown: true } };
/** The levels the helper logs at in debug mode, and the longest line it can send. */
const LOG_LEVELS = ["info", "warn"];
const MAX_LOG_LENGTH = 1000;
const HEX = /^[0-9a-f]{6}$/i;
/** The app's color picker style, as in its theme settings. */
const COLOR_INPUT = "size-7 shrink-0 rounded-lg border border-input bg-transparent p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-moz-color-swatch]:rounded-sm [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0";
/** Delay before a color being dragged in the picker is saved, in milliseconds. */
const COLOR_SAVE_DELAY = 300;
const PROCESS = "manabar-windows";
const IDLE = { state: "off", percent: 0, color: "", prompt: false, hotbar: "off" };
/** The hotbar keys, in slot order. */
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "="];
const SKILL_ID = /^[a-z0-9_-]{1,31}$/;
/** A skill name as the helper accepts it: printable ASCII without quotes or backslashes. */
const SKILL_NAME = /^[ !#-[\]-~]{1,31}$/;
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
const spellIds = (value, allowed) => Array.isArray(value) ? allowed.filter((spell) => value.includes(spell.id)).map((spell) => spell.id) : [];

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
    warnings: spellIds(value.warnings, SPELLS.filter((spell) => spell.warning)),
    sound: typeof value.sound === "boolean" ? value.sound : DEFAULTS.sound,
    debug: typeof value.debug === "boolean" ? value.debug : DEFAULTS.debug,
    cooldowns: readCooldowns(value.cooldowns),
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
  const lastCast = createStore(null);
  const EMPTY_HOTBAR = { slots: [], names: [], selected: -1, reader: true, small: false };
  const hotbar = createStore(EMPTY_HOTBAR);

  const backpack = createStore(false);

  /** Shares whether the backpack is open, for widgets that pause while it is. Toolblox 0.4.6 can't share. */
  const share = toolblox.share;
  const condition = `${toolblox.widget.id}:backpack`;
  const watched = () => share?.get("autoclicker.pause.watch").some(({ value }) => Array.isArray(value) && value.includes(condition)) ?? false;
  const publish = () => share?.set("autoclicker.pause", [{ id: "backpack", label: "Pause when backpack is open", active: backpack.get() }]);
  const setBackpack = (open) => { if (backpack.get() !== open) { backpack.set(open); publish(); } };
  publish();

  const stopped = () => { helper.set({ ...helper.get(), status: "stopped" }); reading.set(IDLE); hotbar.set(EMPTY_HOTBAR); setBackpack(false); };
  const running = () => config.get().enabled || config.get().cooldowns.enabled || watched();

  function handle(events) {
    for (const event of events) {
      if (event.processId !== PROCESS || event.stream !== "stdout") continue;
      let message;
      try { message = JSON.parse(event.line); } catch { void toolblox.log.warn(`Ignored helper output that isn't JSON: ${event.line.slice(0, 200)}`); continue; }
      if (message?.type === "ready") {
        helper.set({ status: "running", supported: message.supported === true });
      } else if (message?.type === "status") {
        reading.set({ state: String(message.state), percent: Number(message.percent) || 0, color: /^[0-9a-f]{6}$/.test(message.color) ? message.color : "", prompt: message.prompt === true, gate: message.gate === true, hotbar: String(message.hotbar ?? "off") });
      } else if (message?.type === "hotbar") {
        const list = (value) => Array.isArray(value) ? value.slice(0, KEYS.length).map(String) : [];
        hotbar.set({ slots: list(message.slots), names: list(message.names), selected: Number.isInteger(message.selected) ? message.selected : -1, reader: message.reader !== false, small: message.small === true });
      } else if (message?.type === "log" && LOG_LEVELS.includes(message.level) && typeof message.message === "string") {
        void toolblox.log[message.level](message.message.slice(0, MAX_LOG_LENGTH));
      } else if (message?.type === "backpack") {
        setBackpack(message.open === true);
      } else if (message?.type === "cast") {
        lastCast.set({ spell: SPELLS.find((spell) => spell.id === message.spell), percent: Number(message.percent) || 0, ok: message.ok === true });
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
      stopped();
      toolblox.notify(`The Rogue Lineage helper isn't responding. Can the overlay be turned on again? (${error})`, "error");
      return false;
    }
  }

  const configure = () => {
    const { enabled, tracked, colors, warnings, sound, debug, cooldowns } = config.get();
    const gate = SPELLS.find((spell) => spell.id === "gate");
    const zones = tracked.map((entry) => zone(resolve(entry, colors))).join(";");
    return send({ type: "configure", enabled, zones, gate: warnings.includes(gate.id), gateMin: gate.min, gateMax: gate.max, sound,
      cooldowns: cooldowns.enabled, shade: cooldowns.shade, shadeOpacity: cooldowns.opacity, countdown: cooldowns.countdown, debug, backpack: watched() });
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
    for (const skill of SKILLS) {
      if (!await send({ type: "skill", id: skill.id, name: skill.name, cooldown: Math.round(skill.cooldown * 1000) })) return;
    }
    await configure();
  }

  /**
   * The helper runs only while an overlay is on or another widget watches the backpack, so nothing
   * reads the screen otherwise.
   */
  async function apply() {
    if (!windows) return;
    if (!running()) {
      await toolblox.request("process.stop", { processId: PROCESS }).catch((error) => toolblox.log.warn(`Stopping the Rogue Lineage helper failed: ${error}`));
      stopped();
    } else if (helper.get().status === "running") {
      await configure();
    } else if (helper.get().status === "stopped") {
      await startHelper();
    }
  }

  function save(changes) {
    config.set({ ...config.get(), ...changes });
    void toolblox.storage.set(config.get()).catch((error) => toolblox.notify(`Rogue Lineage settings weren't saved. Does retrying help? (${error})`, "error"));
    void apply();
  }
  const setWarning = (id, on) => save({ warnings: SPELLS.map((spell) => spell.id).filter((other) => other === id ? on : config.get().warnings.includes(other)) });

  /**
   * Polls the helper every 250 ms while it runs, or every 50 ms while another widget watches the
   * backpack, and restarts it if it exits while it's needed.
   */
  let lastStart = Date.now(), ticks = 0, wasWatched = watched();
  const interval = setInterval(() => {
    const { status } = helper.get();
    if (status !== "stopped") { if (watched() || ++ticks % 5 === 0) void poll(); }
    else if (windows && running() && Date.now() - lastStart > 5_000) { lastStart = Date.now(); void startHelper(true); }
  }, 50);
  const stopWatching = share?.subscribe(() => { if (watched() !== wasWatched) { wasWatched = watched(); void apply(); } });
  cleanup = () => { clearInterval(interval); stopWatching?.(); };

  const Swatch = ({ color }) => h("span", { className: "size-2 shrink-0 rounded-full", style: { backgroundColor: `#${color}` }, "aria-hidden": "true" });
  const Unavailable = () => h(ui.Panel, { className: "p-4" }, h("p", { className: "text-sm text-muted-foreground" }, "Rogue Lineage overlays aren't available on macOS yet."));

  /** Power, what the helper is doing, and the mana percentage it reads. */
  function Status() {
    const { enabled } = use(config);
    const { status, supported } = use(helper);
    const { state, percent, color } = use(reading);
    const tracking = enabled && status === "running" && supported && state === "tracking";
    const label = !enabled ? "Off" : status === "starting" ? "Starting" : status === "stopped" ? "Stopped" : !supported ? "Not supported"
      : tracking ? "Tracking" : state === "searching" ? "Looking for the mana bar" : "Waiting for Roblox";
    const detail = !enabled ? "Shows mana as a percentage over the mana bar."
      : status === "running" && !supported ? "The overlay needs Windows 10 version 2004 or later."
      : tracking ? (color ? h("span", { className: "flex items-center gap-2" }, h(Swatch, { color }), "Mana color read from the bar") : "Mana color is read on the first charge.")
      : state === "searching" ? "Found once the bar is on screen and less than three quarters full."
      : "Starts when Roblox is focused.";
    return h(system.Console, { status: label, tone: tracking ? "success" : enabled && supported ? "warning" : "muted", value: tracking ? `${percent}%` : "—", detail,
      control: h(system.PowerButton, { on: enabled, label: "Mana bar overlay", disabled: status === "starting", onClick: () => save({ enabled: !enabled }) }) });
  }

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
    return h(system.Tile, { label: "Tracked spells", wide: true, action: !draft && menu }, h("div", null,
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
      !draft && !tracked.length && h(system.TileRow, null, h("p", { className: "text-sm text-muted-foreground" }, "No tracked spells"))));
  }

  /** The backfire warning for each spell whose casts the helper can detect, with the last cast it saw. */
  function Warnings() {
    const { enabled, warnings } = use(config);
    const { status } = use(helper);
    const { prompt, gate } = use(reading);
    const cast = use(lastCast);
    const note = cast ? `Last ${cast.spell?.name ?? "cast"}: ${cast.percent}%, ${cast.ok ? "in range" : "out of range"}` : gate ? "Gate equipped" : prompt ? "Gate prompt on screen" : null;
    return h(system.Tile, { label: "Backfire warning", wide: true,
      action: h(ui.Button, { variant: "outline", size: "sm", disabled: !enabled || status !== "running", onClick: () => void send({ type: "test" }) }, "Test") },
      h("div", null,
        SPELLS.filter((spell) => spell.warning).map((spell) =>
          h(system.TileRow, { key: spell.id, actions: h(ui.Switch, { checked: warnings.includes(spell.id), onCheckedChange: (on) => setWarning(spell.id, on), "aria-label": `${spell.name} backfire warning` }) },
            h("span", { className: "flex min-w-0 flex-col" },
              h("span", { className: "text-sm font-medium" }, spell.name),
              h("span", { className: "truncate text-xs text-muted-foreground" }, `Flashes the screen when ${spell.name} is cast outside ${range(spell)}.`)))),
        note && h(system.TileRow, null, h("p", { className: "text-sm text-muted-foreground", role: "status" }, note))));
  }

  function ManaBar() {
    if (!windows) return h(Unavailable);
    return h(system.Split, { start: h(Status), end: h(React.Fragment, null, h(Spells), h(Warnings)) });
  }

  const saveCooldowns = (changes) => save({ cooldowns: { ...config.get().cooldowns, ...changes } });
  const skillById = (id) => SKILLS.find((skill) => skill.id === id);

  /** Power, what the helper is doing, and how many hotbar slots hold a supported skill. */
  function CooldownStatus() {
    const { enabled } = use(config).cooldowns;
    const { status, supported } = use(helper);
    const { hotbar: state } = use(reading);
    const { slots, reader, small } = use(hotbar);
    const tracking = enabled && status === "running" && supported && state === "tracking";
    const known = slots.filter((id) => skillById(id)).length;
    const label = !enabled ? "Off" : status === "starting" ? "Starting" : status === "stopped" ? "Stopped" : !supported ? "Not supported"
      : tracking ? "Tracking" : state === "searching" ? "Looking for the hotbar" : "Waiting for Roblox";
    const detail = !enabled ? "Shades a skill's hotbar slot while it cools down."
      : status === "running" && !supported ? "The overlay needs Windows 10 version 2004 or later."
      : tracking && !reader ? "Skill names couldn't be read. Is an OCR language installed in Windows settings?"
      : tracking && small ? "The hotbar is too small to read every skill name. Can the Roblox window be larger?"
      : tracking ? `${known === 1 ? "1 supported skill" : `${known} supported skills`} in ${slots.length} slots`
      : state === "searching" ? "Found once the hotbar is on screen."
      : "Starts when Roblox is focused.";
    return h(system.Console, { status: label, tone: tracking ? "success" : enabled && supported ? "warning" : "muted", value: tracking ? `${known}/${slots.length}` : "—", detail,
      control: h(system.PowerButton, { on: enabled, label: "Cooldown overlay", disabled: status === "starting", onClick: () => saveCooldowns({ enabled: !enabled }) }) });
  }

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
      h("div", { className: "relative min-h-24 flex-1" },
        h("div", { className: "absolute inset-0 overflow-hidden mask-b-from-70%", "aria-hidden": "true" }, SKILLS.map(skillRow))),
      h(ui.Modal, { open, close: () => setOpen(false), size: "portrait", title: "Supported skills", description: "Skills the cooldown overlay shades.", action: "Done", submit: () => setOpen(false) },
        h("div", { className: "min-h-0 flex-1 overflow-y-auto" }, SKILLS.map(skillRow))));
  }

  function Cooldowns() {
    if (!windows) return h(Unavailable);
    return h(system.Split, { start: h(React.Fragment, null, h(CooldownStatus), h(Hotbar)), end: h(Supported) });
  }

  /** The page's tabs, in order. Each feature of the widget adds one entry. */
  const TABS = [{ id: "mana-bar", label: "Mana bar overlay", Component: ManaBar }, { id: "cooldowns", label: "Cooldown overlay", Component: Cooldowns }];

  toolblox.registerPage(function RogueLineagePage() {
    const [tab, setTab] = React.useState(TABS[0].id);
    return h(ui.Tabs, { value: tab, onValueChange: setTab, className: "flex-1 gap-4" },
      h(ui.TabsList, { className: "bg-transparent p-0" }, TABS.map((item) => h(ui.TabsTrigger, { key: item.id, value: item.id, className: "flex-none px-3" }, item.label))),
      TABS.map((item) => h(ui.TabsContent, { key: item.id, value: item.id, className: "flex flex-col" }, h(item.Component))));
  });

  toolblox.registerSettings(function RogueLineageSettings() {
    const current = use(config);
    if (!windows) return h(Unavailable);
    return h("div", { className: "grid items-start gap-4 @5xl:grid-cols-2" },
      h(ui.Group, { title: "General" }, h(ui.Panel, { className: "divide-y" },
        h(ui.SwitchRow, { title: "Debug mode", description: "Labels what both overlays detect on screen, and logs each step to the Toolblox log.",
          checked: current.debug, change: (debug) => save({ debug }) }))),
      h(ui.Group, { title: "Backfire warning" }, h(ui.Panel, { className: "divide-y" },
        h(ui.SwitchRow, { title: "Warning sound", description: "Plays the Windows error sound with the flash.", checked: current.sound, change: (sound) => save({ sound }) }))),
      h(ui.Group, { title: "Cooldown overlay" }, h(ui.Panel, { className: "divide-y" },
        h(ui.SettingRow, { title: "Shade color", description: "Covers a slot while its skill cools down.",
          control: () => h(ColorInput, { color: current.cooldowns.shade, label: "Shade color", change: (shade) => saveCooldowns({ shade }) }) }),
        h(ui.SliderRow, { title: "Shade opacity", value: current.cooldowns.opacity, min: 20, max: 90, step: 5, unit: "%", change: (opacity) => saveCooldowns({ opacity }) }),
        h(ui.SwitchRow, { title: "Countdown", description: "Shows the seconds left in the middle of the slot.", checked: current.cooldowns.countdown, change: (countdown) => saveCooldowns({ countdown }) }))));
  });

  if (windows && running()) void startHelper();
}

export function deactivate() {
  cleanup();
}
