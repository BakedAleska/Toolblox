/**
 * A message between windows about one widget's shared value, with `value` absent when it was
 * removed, or a request to repeat them. `source` identifies the sending window.
 */
export type ShareMessage = { source: string; kind: "value"; widgetId: string; topic: string; value?: unknown } | { source: string; kind: "sync" };

/** Carries messages to every window, this one included. */
export type ShareTransport = { send: (message: ShareMessage) => void; listen: (listener: (message: ShareMessage) => void) => void };

/** One widget's value for a topic. */
export type SharedValue = { widgetId: string; value: unknown };

/**
 * Values that widgets share with each other by topic, kept the same in every window. Each widget
 * holds at most one JSON value per topic, and a window ignores its own messages when they return. A window asks the others to repeat their values when it
 * starts, and repeats its own when asked.
 */
export function createShare(transport: ShareTransport) {
  const values = new Map<string, Map<string, unknown>>();
  const own = new Map<string, Map<string, unknown>>();
  const listeners = new Set<() => void>();
  const source = crypto.randomUUID();
  let version = 0;

  const apply = (widgetId: string, topic: string, value: unknown) => {
    const current = values.get(topic) ?? new Map<string, unknown>();
    if (JSON.stringify(current.get(widgetId)) === JSON.stringify(value)) return;
    if (value === undefined) current.delete(widgetId);
    else current.set(widgetId, value);
    values.set(topic, current);
    version += 1;
    listeners.forEach((listener) => listener());
  };

  transport.listen((message) => {
    if (message.source === source) return;
    if (message.kind === "value") apply(message.widgetId, message.topic, message.value);
    else own.forEach((topics, widgetId) => topics.forEach((value, topic) => transport.send({ source, kind: "value", widgetId, topic, value })));
  });

  /** Sets `widgetId`'s value for `topic`, or removes it with `undefined`. The value must survive JSON. */
  const set = (widgetId: string, topic: string, value: unknown) => {
    const copy = value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown;
    const topics = own.get(widgetId) ?? new Map<string, unknown>();
    if (copy === undefined) topics.delete(topic);
    else topics.set(topic, copy);
    own.set(widgetId, topics);
    apply(widgetId, topic, copy);
    transport.send({ source, kind: "value", widgetId, topic, value: copy });
  };

  return {
    set,
    /** Removes every value `widgetId` set in this window. */
    clear(widgetId: string) {
      [...(own.get(widgetId)?.keys() ?? [])].forEach((topic) => set(widgetId, topic, undefined));
      own.delete(widgetId);
    },
    /** Every widget's value for `topic`, in no particular order. */
    get: (topic: string): SharedValue[] => [...(values.get(topic) ?? [])].map(([widgetId, value]) => ({ widgetId, value })),
    /** Calls `listener` after any value changes. Returns a function that stops it. */
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    version: () => version,
    /** Asks the other windows to repeat their values. */
    sync: () => transport.send({ source, kind: "sync" }),
  };
}
