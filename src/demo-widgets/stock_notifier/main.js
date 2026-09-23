// Demo module widget. A real version would refresh this list with `toolblox.request("network.fetch", ...)`.

const ITEMS = [
  { name: "Katana", stock: 3 },
  { name: "Healing potion", stock: 0 },
  { name: "Silver ring", stock: 12 },
  { name: "Scroll of flight", stock: 1 },
];

export function activate(toolblox) {
  const { React, ui } = toolblox;
  const h = React.createElement;
  const bag = h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
    h("path", { d: "M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" }), h("path", { d: "M3 6h18" }), h("path", { d: "M16 10a4 4 0 0 1-8 0" }));

  toolblox.addToSlot("dashboard.stats", () => h(ui.StatTile, {
    icon: bag,
    label: "Shop items in stock",
    value: ITEMS.filter((item) => item.stock > 0).length,
  }));

  toolblox.addToSlot("dashboard.sections", () => h("section", { className: "flex flex-col gap-2" },
    h(ui.SectionTitle, null, "Shop stock"),
    h(ui.Panel, { className: "divide-y" }, ITEMS.map((item) => h("div", { key: item.name, className: "flex items-center justify-between gap-3 px-4 py-2 text-sm" },
      h("span", null, item.name),
      h(ui.Badge, { variant: "secondary", className: item.stock ? "text-success" : "text-muted-foreground" }, item.stock ? `${item.stock} in stock` : "Sold out"))))));
}
