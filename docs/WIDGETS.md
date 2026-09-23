# Widget development

A widget is a ZIP package with a `widget.json` manifest. Toolblox installs only packages listed in
its signed catalogue, and every catalogue widget passes marketplace review first. Development
builds also load unpacked widget folders from the widgets folder shown on the Widgets page.

## Module widgets

A module widget declares `"module": "main.js"`. Toolblox imports that ES module into the app
window and calls its `activate` export with the host API. Module widgets have full access: they
can add pages, replace core screens, extend slots, restyle the app, and call every host method.
Roblox session cookies are the one exception. They never leave Rust, for widgets or for the
Toolblox interface itself.

```json
{
  "schemaVersion": 1,
  "id": "rogue_lineage",
  "name": "Rogue Lineage",
  "version": "1.0.0",
  "module": "main.js"
}
```

```js
export async function activate(toolblox) {
  const { React, ui } = toolblox;
  const h = React.createElement;

  toolblox.addToSlot("accounts.row", ({ account }) => h(ui.Badge, { variant: "outline" }, "Lightborn"));
  toolblox.registerPage(() => h(ui.Panel, { className: "p-4" }, "Widget page"));
  toolblox.registerSettings(() => h(ui.SwitchRow, { title: "Race icons", checked: true, change: () => {} }));
}

export function deactivate() {}
```

Use `toolblox.React` instead of bundling React. A second copy of React breaks hooks. JSX works
with any bundler configured to use `toolblox.React.createElement` as the JSX factory. Complete
examples live in `src/demo-widgets/`.

### Host API

| Member | Purpose |
| --- | --- |
| `widget` | This widget's `id`, `name`, and `version`. |
| `React`, `ui` | The app's React instance and components: `Avatar`, `Badge`, `Button`, `Checkbox`, `ChoiceRow`, `DropdownMenu*`, `EmptyState`, `IconButton`, `Input`, `Panel`, `SectionTitle`, `Spinner`, `StatTile`, `Switch`, `SwitchRow`, `Tabs*`, `ToggleGroup*`, `Tooltip*`, and `cn`. |
| `getState()`, `useAppState()`, `onStateChange(listener)` | Current app state: accounts, settings, widgets, and recent places. |
| `navigate(route)`, `notify(message)`, `refresh()`, `join(accountIds)` | App actions, including the Join flow with its place prompt. |
| `registerPage(Component)` | The widget's page at `/widgets/<id>`. |
| `registerSettings(Component)` | The widget's settings page at `/widgets/<id>/settings`. Toolblox Settings stays separate. |
| `replaceScreen(screen, Component)` | Replaces `"dashboard"`, `"accounts"`, or `"widgets"`. Settings can't be replaced. |
| `addToSlot(slot, Component, { order })` | Adds to a slot. See the table below. |
| `addStyles(css)` | Adds a stylesheet to the whole app, for example to override theme tokens on `:root`. |
| `storage.get()`, `storage.set(value)` | One JSON value for the widget, up to 1 MB. |
| `request(method, params)` | Every IPC method below, with all permissions granted. |

Every registration returns a function that removes it. Toolblox also removes all of a widget's
contributions when it's disabled, updated, or uninstalled.

| Slot | Props | Placement |
| --- | --- | --- |
| `accounts.row` | `{ account }` | Under each account's name on the Accounts page. |
| `accounts.toolbar` | none | Start of the Accounts page toolbar. |
| `dashboard.stats` | none | After the Dashboard stat tiles. `ui.StatTile` matches them. |
| `dashboard.sections` | none | Below the Dashboard stats. |
| `sidebar.footer` | `{ collapsed }` | Bottom of the sidebar. |

Tailwind classes are compiled into the app ahead of time, so only classes the app already uses are
available. Ship other styles with `addStyles`.

### Failure handling

Each contribution renders inside an error boundary, so a failing widget shows an inline error
instead of breaking the screen. A widget that makes the app unusable can be bypassed with
**Restart without widgets** in the tray menu, or by starting Toolblox with `--safe-mode`. Safe
mode lasts for one session.

## Iframe widgets

Widgets can instead, or also, declare sandboxed pages: `"entry": "index.html"`,
`"settingsEntry": "settings.html"`, and `"dashboardEntry": "dashboard.html"`. These run with
`sandbox="allow-scripts"` and communicate with `postMessage`:

```js
window.parent.postMessage({
  type: "toolbloxRequest",
  request: { protocol: 1, requestId: crypto.randomUUID(), method: "accounts.list", params: {} },
}, "*");
```

Iframe surfaces receive only the permissions their manifest declares.

## IPC methods

Methods are listed in [`widget-ipc-v1.schema.json`](../schemas/widget-ipc-v1.schema.json).
`widgetData.get` and `widgetData.set` store per-account data namespaced by widget ID.
`network.fetch` accepts HTTPS text responses up to 1 MB. `process.spawn`, `process.send`,
`process.poll`, and `process.stop` run executables declared under `optional-bin/` with their
exact allowed arguments.

## Catalogue

The catalogue signs its exact JSON bytes with Ed25519. Each entry pins the package SHA-256 and
lists the widget's permissions. Changing whitespace after signing invalidates the signature.
