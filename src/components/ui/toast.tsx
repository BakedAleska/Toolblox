import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Short status messages in a bottom corner of their container, on the given side. The oldest
 * toast sits at the bottom and newer ones stack above it. Toasts slide in from that side's edge and
 * leave the same way, so none crosses another. Each shows an icon, a title, a description of up to
 * two lines, and a ring for the time left. Toasts widen to fit their text before they wrap.
 * Keyboard focus pauses the timer, and selecting a toast dismisses it. */

export type ToastKind = "success" | "error" | "warning" | "info";

type Toast = { id: number; kind: ToastKind; title: string; description: string; leaving: boolean };

const KINDS = {
  success: { icon: CircleCheck, color: "text-success", bar: "bg-success" },
  error: { icon: CircleAlert, color: "text-destructive", bar: "bg-destructive" },
  warning: { icon: TriangleAlert, color: "text-warning", bar: "bg-warning" },
  info: { icon: Info, color: "text-muted-foreground", bar: "bg-muted-foreground" },
};

/**
 * Splits a message into its first sentence, the title, and the rest, the description. Error
 * messages end with a recovery question, so a message with a question is an error unless `kind`
 * says otherwise, and any other message is a success.
 */
export function parseToast(message: string, kind?: ToastKind) {
  const [, first = message, rest = ""] = message.match(/^(.+?[.!?])\s+(.+)$/s) ?? [];
  return { kind: kind ?? (message.includes("?") ? "error" : "success"), title: first.replace(/\.$/, ""), description: rest };
}

const DURATION = 4000;
const LIMIT = 3;
/** Starts gently so the slide in from the edge is visible, then settles. */
const ENTER = { duration: 300, easing: "cubic-bezier(0.2, 0, 0, 1)" };
const EXIT = { duration: 180, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" as const };
let nextId = 0;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((message: string, kind?: ToastKind) => setToasts((current) => {
    const next = [...current, { id: ++nextId, ...parseToast(message, kind), leaving: false }];
    const overflow = next.filter(({ leaving }) => !leaving).length - LIMIT;
    let dropped = 0;
    return next.map((toast) => !toast.leaving && dropped < overflow ? (dropped++, { ...toast, leaving: true }) : toast);
  }), []);
  const dismiss = useCallback((id: number) => setToasts((current) => current.map((toast) => toast.id === id ? { ...toast, leaving: true } : toast)), []);
  const remove = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  return { toasts, notify, dismiss, remove };
}

export function Toaster({ toasts, dismiss, remove, side }: ReturnType<typeof useToasts> & { side: "left" | "right" }) {
  return <div data-toaster role="status" aria-live="polite" className="pointer-events-none absolute inset-x-4 bottom-4 z-50 flex flex-col-reverse">
    {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} side={side} dismiss={() => dismiss(toast.id)} remove={() => remove(toast.id)} />)}
  </div>;
}

/** The distance that moves a toast fully past the `side` edge of the toaster's container. */
const offscreen = (toast: HTMLElement, side: "left" | "right") => {
  const area = toast.closest("[data-toaster]")?.parentElement?.getBoundingClientRect();
  const rect = toast.getBoundingClientRect();
  return side === "right"
    ? `translateX(${(area?.right ?? window.innerWidth) - rect.left + 16}px)`
    : `translateX(${(area?.left ?? 0) - rect.right - 16}px)`;
};

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function ToastItem({ toast, side, dismiss, remove }: { toast: Toast; side: "left" | "right"; dismiss: () => void; remove: () => void }) {
  const ring = useRef<SVGCircleElement>(null);
  const card = useRef<HTMLButtonElement>(null);
  const timer = useRef<Animation>(undefined);
  const expire = useRef(dismiss);
  const removed = useRef(remove);
  expire.current = dismiss;
  removed.current = remove;

  useEffect(() => {
    const circle = ring.current;
    if (!circle) return;
    const animation = circle.animate([{ strokeDashoffset: "0" }, { strokeDashoffset: "-1" }], { duration: DURATION, fill: "forwards" });
    animation.onfinish = () => expire.current();
    timer.current = animation;
    return () => { animation.onfinish = null; animation.cancel(); };
  }, []);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const animation = element.animate(reducedMotion() ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: offscreen(element, side) }, { transform: "none" }], ENTER);
    return () => animation.cancel();
  }, []);

  useEffect(() => {
    const element = card.current;
    if (!toast.leaving || !element) return;
    timer.current?.pause();
    const animation = element.animate(reducedMotion() ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: "none" }, { transform: offscreen(element, side) }], EXIT);
    animation.onfinish = () => removed.current();
  }, [toast.leaving]);

  const { icon: Icon, color, bar } = KINDS[toast.kind];
  return <div className={`grid w-full transition-[grid-template-rows] duration-200 ${toast.leaving ? "grid-rows-[0fr] ease-exit" : "grid-rows-[1fr]"}`}>
    <div className={cn("flex min-h-0 items-end", side === "right" ? "justify-end" : "justify-start")}>
      <button ref={card} type="button" title={toast.description ? `${toast.description}\nSelect to dismiss.` : "Select to dismiss."} disabled={toast.leaving} onClick={dismiss}
        onFocus={() => timer.current?.pause()} onBlur={() => { if (!toast.leaving) timer.current?.play(); }}
        className="pointer-events-auto relative mx-2 mt-2 mb-1 flex w-max max-w-[min(560px,100%)] min-w-64 items-start gap-3 overflow-hidden rounded-xl bg-popover py-2 pr-3 pl-4 text-left text-popover-foreground shadow-lg shadow-shadow/20 ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <span className={cn("absolute inset-y-0 left-0 w-1", bar)} aria-hidden="true" />
        <Icon className={cn("mt-px size-5 shrink-0", color)} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{toast.title}</span>
          {toast.description && <span className="line-clamp-2 text-sm text-muted-foreground">{toast.description}</span>}
        </span>
        <svg viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0 -rotate-90 text-muted-foreground" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-25" />
          <circle ref={ring} cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" pathLength="1" strokeDasharray="1" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  </div>;
}
