import { Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { anchoredMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { applyInput, commitDraft, emptySearch, macroFor, suggest, type Filter, type SearchState, type Suggestion } from "@/search";
import type { AppState } from "@/types";

const chip = "inline-flex h-6 shrink-0 items-center rounded-md bg-foreground/8 text-xs ring-1 ring-foreground/12";

function FilterChip({ filter, remove }: { filter: Filter; remove: () => void }) {
  const macro = macroFor(filter.key);
  return <span className={cn(chip, "pl-1.5")} title={macro.description}>
    <span className="text-muted-foreground">{filter.key}:</span>
    <span className={cn("max-w-40 truncate pl-1 font-medium", !macro.spaces && "font-mono")}>{filter.value}</span>
    <button type="button" className="ml-0.5 grid size-5 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label={`Remove ${filter.key} filter${filter.value ? ` ${filter.value}` : ""}`} onClick={remove}><X className="size-3" /></button>
  </span>;
}

/** Account search field. Filters typed as `#key:value` become chips, and suggestions complete
 * names, filter keys, and filter values. */
export function AccountSearch({ app, value, onChange }: { app: Pick<AppState, "accounts" | "recentPlaces">; value: SearchState; onChange: (value: SearchState) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [shown, setShown] = useState(false);
  const suggestions = useMemo(() => suggest(value, app), [value, app]);
  const open = focused && !dismissed && !!suggestions;
  const last = useRef(suggestions);
  if (open) last.current = suggestions;
  if (open && !shown) setShown(true);
  const list = open ? suggestions : last.current;
  const index = list ? Math.min(active, list.items.length - 1) : -1;
  useEffect(() => { if (open && index >= 0) document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: "nearest" }); }, [open, index, listId]);
  const macro = value.draft && macroFor(value.draft);
  /** Tab and Enter complete a suggestion only once something is typed or chosen. */
  const armed = navigated || !!value.text || !!value.draft;

  const update = (next: SearchState) => { onChange(next); setActive(0); setNavigated(false); setDismissed(false); };
  const accept = (suggestion: Suggestion) => { update(suggestion.apply); input.current?.focus(); };
  const remove = (at: number) => { update({ ...value, filters: value.filters.filter((_, i) => i !== at) }); input.current?.focus(); };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const target = event.currentTarget;
    const atStart = target.selectionStart === 0 && target.selectionEnd === 0;
    if (open && suggestions && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const count = suggestions.items.length;
      setActive(navigated ? (index + (event.key === "ArrowDown" ? 1 : count - 1)) % count : event.key === "ArrowDown" ? 0 : count - 1);
      setNavigated(true);
    } else if (open && suggestions && (event.key === "Tab" || event.key === "Enter") && !event.shiftKey && armed) {
      event.preventDefault();
      accept(suggestions.items[index]);
    } else if (event.key === "Enter") {
      update(commitDraft(value));
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setDismissed(true);
    } else if (event.key === "Backspace" && atStart && !value.text) {
      if (value.draft) { event.preventDefault(); update({ filters: value.filters, text: `#${value.draft}` }); }
      else if (value.filters.length) {
        event.preventDefault();
        const previous = value.filters[value.filters.length - 1];
        update({ filters: value.filters.slice(0, -1), draft: previous.key, text: previous.value });
      }
    }
  };

  const empty = !value.filters.length && !value.draft && !value.text;
  const placeholder = macro ? `${macro.placeholder}…` : value.filters.length ? "" : "Search";

  return <div className="relative min-w-0 flex-1 basis-0">
    <div className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-input bg-transparent pr-1 pl-2.5 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30"
      onMouseDown={(event) => { if (event.target !== input.current) { event.preventDefault(); input.current?.focus(); } }}>
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {value.filters.map((filter, i) => <FilterChip key={`${i}-${filter.key}-${filter.value}`} filter={filter} remove={() => remove(i)} />)}
        <span className={cn(macro ? cn(chip, "px-1.5 ring-ring/60") : "flex min-w-0 flex-1")}>
          {macro && <span className="text-muted-foreground">{macro.key}:</span>}
          <span className={macro ? "inline-grid pl-1" : "grid min-w-0 flex-1"}>
            {macro && <span className="invisible col-start-1 row-start-1 whitespace-pre" aria-hidden="true">{value.text || placeholder}</span>}
            <input ref={input} value={value.text} placeholder={placeholder} spellCheck={false} autoComplete="off"
              role="combobox" aria-label="Search accounts" aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
              aria-activedescendant={open && armed && index >= 0 ? `${listId}-${index}` : undefined}
              className={cn("col-start-1 row-start-1 w-full min-w-[1ch] bg-transparent text-sm outline-none placeholder:text-muted-foreground", macro && !macro.spaces && "font-mono placeholder:font-sans")}
              onChange={(event) => update(applyInput(value, event.target.value))} onKeyDown={keyDown}
              onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => setFocused(false)} />
          </span>
        </span>
      </div>
      {!empty && <Button variant="ghost" size="icon-xs" aria-label="Clear search" onClick={() => { update(emptySearch); input.current?.focus(); }}><X /></Button>}
    </div>
    {shown && list && <div id={listId} role="listbox" aria-label={list.title} data-side="bottom" data-open={open ? "" : undefined} data-closed={open ? undefined : ""}
      onAnimationEnd={() => { if (!open) setShown(false); }} onMouseDown={(event) => event.preventDefault()}
      className={cn("absolute inset-x-0 top-full z-50 mt-1 min-w-64 origin-top overflow-hidden rounded-xl bg-popover p-1 text-popover-foreground shadow-lg shadow-shadow/10 ring-1 ring-foreground/10", anchoredMotion, !open && "pointer-events-none")}>
      <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{list.title}</p>
      <div className="max-h-40 overflow-y-auto overscroll-contain">
        {list.items.map((item, i) => <div key={item.id} id={`${listId}-${i}`} role="option" aria-selected={armed && i === index}
          className={cn("flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors duration-100", armed && i === index && "bg-accent text-accent-foreground")}
          onMouseMove={() => { setActive(i); setNavigated(true); }} onClick={() => accept(item)}>
          <span className={cn("min-w-0 truncate", item.mono && "font-mono")}>{item.label}</span>
          {item.detail && <span className="ml-auto min-w-0 truncate pl-2 text-xs text-muted-foreground">{item.detail}</span>}
        </div>)}
      </div>
      <p className="mt-1 border-t px-2 pt-1.5 pb-1 text-2xs text-muted-foreground"><kbd className="font-sans font-medium">Tab</kbd> to complete · <kbd className="font-sans font-medium">↑↓</kbd> to choose</p>
    </div>}
  </div>;
}
