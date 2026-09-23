// Demo module widget. Real widgets ship the same shape as `main.js` in their package.
// It uses its own markup and stylesheet instead of the host components to show full visual control.

const RACES = { lightborn: "Lightborn", vind: "Vind", gaian: "Gaian", dinakeri: "Dinakeri" };
const CLASSES = { druid: "Druid", shinobi: "Shinobi", necromancer: "Necromancer", illusionist: "Illusionist" };

const WIDGET_CSS = `
.rl-page, .rl-tag, .rl-stat, .rl-settings {
  --rl-ink: #1a110d; --rl-ink-2: #2a1a14; --rl-parchment: #ead9b0; --rl-muted: #b8a27a;
  --rl-gold: #c9a44c; --rl-gold-2: #f0cf7a; --rl-ember: #9c3a24;
  font-family: "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
}
.rl-page {
  position: relative; display: flex; flex-direction: column; gap: 20px; padding: 24px;
  color: var(--rl-parchment); border: 1px solid color-mix(in srgb, var(--rl-gold) 55%, transparent); border-radius: 4px;
  background:
    radial-gradient(120% 80% at 50% 0%, color-mix(in srgb, var(--rl-ember) 35%, transparent), transparent 60%),
    linear-gradient(180deg, var(--rl-ink-2), var(--rl-ink));
  box-shadow: inset 0 0 0 4px var(--rl-ink), inset 0 0 0 5px color-mix(in srgb, var(--rl-gold) 35%, transparent), 0 12px 32px rgb(0 0 0 / 35%);
}
.rl-page::before, .rl-page::after {
  content: "\\2726"; position: absolute; top: 8px; color: var(--rl-gold); font-size: 14px; line-height: 1;
}
.rl-page::before { left: 12px; } .rl-page::after { right: 12px; }
.rl-hero { display: flex; align-items: center; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid color-mix(in srgb, var(--rl-gold) 30%, transparent); }
.rl-crest {
  display: grid; place-items: center; width: 52px; height: 52px; flex: none; transform: rotate(45deg);
  border: 1px solid var(--rl-gold); background: linear-gradient(135deg, var(--rl-ember), var(--rl-ink));
  box-shadow: 0 0 18px color-mix(in srgb, var(--rl-ember) 55%, transparent);
}
.rl-crest span { transform: rotate(-45deg); color: var(--rl-gold-2); font-size: 22px; }
.rl-hero h2 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--rl-gold-2); text-shadow: 0 1px 0 #000; }
.rl-hero p { margin: 4px 0 0; font-style: italic; color: var(--rl-muted); }
.rl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.rl-card {
  display: flex; flex-direction: column; gap: 10px; padding: 14px;
  border: 1px solid color-mix(in srgb, var(--rl-gold) 30%, transparent); border-radius: 2px;
  background: linear-gradient(160deg, color-mix(in srgb, var(--rl-parchment) 7%, transparent), transparent 70%), var(--rl-ink);
  transition: border-color 150ms, transform 150ms;
}
.rl-card:hover { border-color: var(--rl-gold); transform: translateY(-1px); }
.rl-card-head { display: flex; align-items: center; gap: 12px; }
.rl-sigil { width: 36px; height: 36px; flex: none; border-radius: 50%; border: 1px solid var(--rl-gold); background: var(--rl-ink-2); display: grid; place-items: center; overflow: hidden; }
.rl-sigil img { width: 100%; height: 100%; }
.rl-sigil span { color: var(--rl-muted); font-size: 16px; }
.rl-card h3 { margin: 0; font-size: 17px; font-weight: 600; color: var(--rl-parchment); }
.rl-card-sub { font-size: 12px; font-style: italic; color: var(--rl-muted); }
.rl-label { font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--rl-gold); }
.rl-runes { display: flex; flex-wrap: wrap; gap: 6px; }
.rl-rune {
  cursor: pointer; padding: 4px 10px; font: inherit; font-size: 13px; color: var(--rl-muted);
  border: 1px solid color-mix(in srgb, var(--rl-gold) 25%, transparent); border-radius: 2px; background: transparent;
  transition: color 120ms, background 120ms, border-color 120ms;
}
.rl-rune:hover { color: var(--rl-parchment); border-color: var(--rl-gold); }
.rl-rune[aria-pressed="true"] { color: var(--rl-ink); background: linear-gradient(180deg, var(--rl-gold-2), var(--rl-gold)); border-color: var(--rl-gold-2); }
.rl-rune:focus-visible { outline: 2px solid var(--rl-gold-2); outline-offset: 2px; }
.rl-tag {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; font-size: 11px; font-variant: small-caps; letter-spacing: 0.06em;
  color: #5b3a12; border: 1px solid #c9a44c; border-radius: 2px; background: linear-gradient(180deg, #f6e6bd, #e6cf93);
}
.dark .rl-tag { color: var(--rl-gold-2); background: linear-gradient(180deg, #2c1c14, #1a110d); }
.rl-tag img { width: 12px; height: 12px; }
.rl-stat {
  display: flex; align-items: center; gap: 12px; padding: 16px; text-align: left; cursor: pointer;
  color: var(--rl-parchment); border: 1px solid var(--rl-gold); border-radius: 2px;
  background: linear-gradient(135deg, var(--rl-ember), var(--rl-ink) 70%);
}
.rl-stat:focus-visible { outline: 2px solid var(--rl-gold-2); outline-offset: 2px; }
.rl-stat strong { display: block; font-size: 22px; line-height: 1.1; color: var(--rl-gold-2); }
.rl-stat small { display: block; font-size: 12px; font-style: italic; color: var(--rl-muted); }
.rl-settings { display: flex; flex-direction: column; gap: 8px; }
.rl-settings h2 { margin: 0; font-size: 13px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--rl-gold); }
@media (prefers-reduced-motion: reduce) { .rl-card, .rl-rune { transition: none; } .rl-card:hover { transform: none; } }
`;

// Opt-in theme that reskins all of Toolblox, to show a widget can restyle the whole app.
const APP_THEME_CSS = `
:root, :root.dark {
  color-scheme: dark;
  --background: #140d0a; --foreground: #ead9b0; --card: #1f1511; --card-foreground: #ead9b0;
  --popover: #241814; --popover-foreground: #ead9b0; --primary: #c9a44c; --primary-foreground: #1a110d;
  --secondary: #2c1d17; --secondary-foreground: #ead9b0; --muted: #2c1d17; --muted-foreground: #b8a27a;
  --accent: #33221a; --accent-foreground: #ead9b0; --border: rgb(201 164 76 / 22%); --input: rgb(201 164 76 / 30%);
  --ring: #c9a44c; --sidebar: #0f0907; --sidebar-accent: #2c1d17; --sidebar-border: rgb(201 164 76 / 25%);
}
html { font-family: "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif; }
h1 { letter-spacing: 0.06em !important; text-transform: uppercase; color: #f0cf7a; }
`;

export async function activate(toolblox) {
  const { React, ui } = toolblox;
  const h = React.createElement;
  const icon = (race) => new URL(`./icons/${race}.svg`, import.meta.url).href;
  toolblox.addStyles(WIDGET_CSS);

  let data = { showIcons: true, appTheme: false, accounts: {}, ...((await toolblox.storage.get()) ?? {}) };
  const listeners = new Set();
  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const useData = () => React.useSyncExternalStore(subscribe, () => data);
  let removeTheme;
  const applyTheme = () => {
    if (data.appTheme && !removeTheme) removeTheme = toolblox.addStyles(APP_THEME_CSS);
    if (!data.appTheme && removeTheme) { removeTheme(); removeTheme = undefined; }
  };
  const save = (next) => { data = next; applyTheme(); listeners.forEach((listener) => listener()); void toolblox.storage.set(next); };
  const setAccount = (id, patch) => save({ ...data, accounts: { ...data.accounts, [id]: { ...data.accounts[id], ...patch } } });
  applyTheme();

  toolblox.addToSlot("accounts.row", ({ account }) => {
    const current = useData();
    const entry = current.accounts[account.id];
    if (!entry?.race && !entry?.cls) return null;
    return h(React.Fragment, null,
      entry.race && h("span", { className: "rl-tag" }, current.showIcons && h("img", { src: icon(entry.race), alt: "" }), RACES[entry.race]),
      entry.cls && h("span", { className: "rl-tag" }, CLASSES[entry.cls]));
  });

  const runes = (label, options, value, change) => h("div", { className: "rl-runes", role: "group", "aria-label": label },
    Object.entries(options).map(([key, text]) => h("button", { key, type: "button", className: "rl-rune", "aria-pressed": value === key, onClick: () => change(key) }, text)));

  toolblox.registerPage(function RoguePage() {
    const current = useData();
    const state = toolblox.useAppState();
    return h("div", { className: "rl-page" },
      h("header", { className: "rl-hero" },
        h("div", { className: "rl-crest", "aria-hidden": true }, h("span", null, "⚔")),
        h("div", null, h("h2", null, "The Lineage Ledger"), h("p", null, "Record the blood and calling of each soul you command."))),
      h("div", { className: "rl-grid" }, state.accounts.map((account) => {
        const entry = current.accounts[account.id] ?? {};
        const name = account.displayName || account.name;
        return h("article", { key: account.id, className: "rl-card", "aria-label": name },
          h("div", { className: "rl-card-head" },
            h("div", { className: "rl-sigil", "aria-hidden": true }, entry.race ? h("img", { src: icon(entry.race), alt: "" }) : h("span", null, "?")),
            h("div", null, h("h3", null, name),
              h("div", { className: "rl-card-sub" }, [RACES[entry.race], CLASSES[entry.cls]].filter(Boolean).join(" · ") || "Unsworn"))),
          h("div", { className: "rl-label" }, "Race"), runes(`${name} race`, RACES, entry.race, (race) => setAccount(account.id, { race })),
          h("div", { className: "rl-label" }, "Class"), runes(`${name} class`, CLASSES, entry.cls, (cls) => setAccount(account.id, { cls })));
      })));
  });

  toolblox.registerSettings(function RogueSettings() {
    const current = useData();
    return h("div", { className: "rl-settings" },
      h("h2", null, "Rogue Lineage"),
      h(ui.Panel, { className: "divide-y" },
        h(ui.SwitchRow, { title: "Race icons", description: "Show race icons on the Accounts page.", checked: current.showIcons, change: (showIcons) => save({ ...current, showIcons }) }),
        h(ui.SwitchRow, { title: "Toolblox theme", description: "Restyle all of Toolblox with the Rogue Lineage look.", checked: current.appTheme, change: (appTheme) => save({ ...current, appTheme }) })));
  });

  toolblox.addToSlot("dashboard.stats", () => {
    const current = useData();
    const characters = Object.values(current.accounts).filter((entry) => entry.race).length;
    return h("button", { type: "button", className: "rl-stat", onClick: () => toolblox.navigate(`/widgets/${toolblox.widget.id}`) },
      h("img", { src: icon("lightborn"), alt: "", width: 28, height: 28 }),
      h("span", null, h("strong", null, characters), h("small", null, "Sworn characters")));
  });
}
