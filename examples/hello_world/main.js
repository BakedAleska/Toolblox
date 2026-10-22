/**
 * The example widget that development builds add to the widgets folder. It adds a page with two
 * stat tiles and a button, built from the app's own React and components.
 * Tutorial: https://toolblox.dev/docs/widgets/tutorials/first-widget/
 */
const svg = (h, ...paths) => h("svg", {
  viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
}, ...paths.map((d) => h("path", { key: d, d })));

/** Temporary buttons that show each toast kind. */
const TOASTS = [
  ["Success", "Prices updated. 12 items changed since the last check.", "success"],
  ["Error", "Prices weren't updated. Is the game's site reachable?", "error"],
  ["Warning", "The session expires soon. Signing in again keeps it active.", "warning"],
  ["Info", "A new season starts tomorrow. Prices may change.", "info"],
];

export async function activate(toolblox) {
  const { React, ui } = toolblox;
  const h = React.createElement;
  const usersIcon = svg(h, "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8");
  const playIcon = svg(h, "M6 3v18l15-9Z");

  void toolblox.log.info(`Activated version ${toolblox.widget.version}`);

  toolblox.registerPage(function HelloPage() {
    const state = toolblox.useAppState();
    const [greetings, setGreetings] = React.useState(0);
    const inGame = state.accounts.filter((account) => account.presence === "playing").length;

    const greet = () => {
      setGreetings((count) => count + 1);
      toolblox.notify("Hello, world!");
      void toolblox.log.debug("Greeted");
    };

    return h(React.Fragment, null,
      h("div", { className: "grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3" },
        h(ui.StatTile, { icon: usersIcon, label: "Accounts", value: state.accounts.length, onClick: () => toolblox.navigate("/accounts") }),
        h(ui.StatTile, { icon: playIcon, label: "In game", value: inGame })),
      h("section", { className: "flex flex-col gap-2" },
        h(ui.SectionTitle, null, "Greeting"),
        h(ui.Panel, { className: "flex items-center gap-3 px-4 py-3" },
          h("p", { className: "min-w-0 flex-1 text-sm" }, greetings ? `Greeted ${greetings} times.` : "No greetings yet."),
          h(ui.Button, { variant: "outline", size: "sm", onClick: greet }, "Say hello"))),
      h("section", { className: "flex flex-col gap-2" },
        h(ui.SectionTitle, null, "Toast styles"),
        h(ui.Panel, { className: "flex flex-wrap items-center gap-2 px-4 py-3" },
          ...TOASTS.map(([label, message, kind]) => h(ui.Button, { key: label, variant: "outline", size: "sm", onClick: () => toolblox.notify(message, kind) }, label)))));
  });
}

export function deactivate() {}
