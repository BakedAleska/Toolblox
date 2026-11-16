import { describe, expect, it } from "vitest";
import { createShare, type ShareMessage } from "./share";

/** Windows joined by a transport that delivers every message to each of them, in order. */
function windows(count: number) {
  const listeners: ((message: ShareMessage) => void)[] = [];
  const transport = { send: (message: ShareMessage) => listeners.slice().forEach((listener) => listener(message)), listen: (listener: (message: ShareMessage) => void) => void listeners.push(listener) };
  return Array.from({ length: count }, () => createShare(transport));
}

describe("createShare", () => {
  it("shows a value in every window and removes it", () => {
    const [main, popout] = windows(2);
    main.set("rogue_lineage", "autoclicker.pause", [{ id: "backpack", active: true }]);
    expect(popout.get("autoclicker.pause")).toEqual([{ widgetId: "rogue_lineage", value: [{ id: "backpack", active: true }] }]);
    main.set("rogue_lineage", "autoclicker.pause", undefined);
    expect(popout.get("autoclicker.pause")).toEqual([]);
  });

  it("keeps one value per widget and topic, and clears a widget's values", () => {
    const [main] = windows(1);
    main.set("a", "topic", 1);
    main.set("b", "topic", 2);
    main.set("a", "topic", 3);
    expect(main.get("topic")).toEqual([{ widgetId: "a", value: 3 }, { widgetId: "b", value: 2 }]);
    main.clear("a");
    expect(main.get("topic")).toEqual([{ widgetId: "b", value: 2 }]);
  });

  it("notifies only on change and copies values", () => {
    const [main] = windows(1);
    let calls = 0;
    const stop = main.subscribe(() => { calls += 1; });
    const value = { active: false };
    main.set("a", "topic", value);
    main.set("a", "topic", { active: false });
    value.active = true;
    expect(calls).toBe(1);
    expect(main.get("topic")[0]?.value).toEqual({ active: false });
    stop();
    main.set("a", "topic", 2);
    expect(calls).toBe(1);
  });

  it("repeats values to a window that starts later", () => {
    const listeners: ((message: ShareMessage) => void)[] = [];
    const transport = { send: (message: ShareMessage) => listeners.slice().forEach((listener) => listener(message)), listen: (listener: (message: ShareMessage) => void) => void listeners.push(listener) };
    const main = createShare(transport);
    main.set("rogue_lineage", "topic", "open");
    const popout = createShare(transport);
    expect(popout.get("topic")).toEqual([]);
    popout.sync();
    expect(popout.get("topic")).toEqual([{ widgetId: "rogue_lineage", value: "open" }]);
  });

  it("ignores its own messages when they return late", () => {
    const sent: ShareMessage[] = [];
    let deliver: (message: ShareMessage) => void = () => undefined;
    const main = createShare({ send: (message) => void sent.push(message), listen: (listener) => { deliver = listener; } });
    main.set("a", "topic", true);
    main.set("a", "topic", false);
    deliver(sent[0]!);
    expect(main.get("topic")).toEqual([{ widgetId: "a", value: false }]);
  });
});
