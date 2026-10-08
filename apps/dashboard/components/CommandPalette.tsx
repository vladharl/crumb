"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { Ic } from "@crumb/ui";
import { matchesTerms, splitTerms } from "@/lib/fuzzy";

export type CommandItem = {
  label: string;
  href: string;
  hint?: string;
  keywords?: string;
  /** Only these roles see it (an action the others can't take). Unset: everyone. */
  roles?: readonly string[];
};

export type CommandGroup = { label: string; items: CommandItem[] };

/** Search results from GET /api/v1/palette, which also sends the caller's role. */
export type PaletteResults = { feedback: CommandItem[]; accounts: CommandItem[]; initiatives: CommandItem[] };
export type PaletteResponse = PaletteResults & { role: string };

/** Results plus the (trimmed) query they answer. */
export type Fetched = PaletteResults & { q: string; failed?: boolean };

const SEARCHED: Array<[keyof PaletteResults, string]> = [
  ["feedback", "Feedback"],
  ["accounts", "Accounts"],
  ["initiatives", "Initiatives"],
];
const NONE: PaletteResults = { feedback: [], accounts: [], initiatives: [] };
const DEBOUNCE_MS = 150;

// The active option gets an accent edge, so the keyboard position reads at a
// glance (the hover tint alone is faint).
const ACTIVE: CSSProperties = { boxShadow: "inset 2px 0 0 var(--accent)" };
// Read by screen readers, not shown.
const SR_ONLY: CSSProperties = {
  position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap",
};

/**
 * What the palette lists for query `q`: the entries of the static groups that
 * this role may use and that match every term, then the server's results.
 * Results fetched for an earlier query stay only while they still contain
 * every term, so Enter can't open a row the current query doesn't match.
 * Empty groups drop out.
 */
export function paletteSections(
  groups: CommandGroup[],
  role: string | null,
  q: string,
  fetched: Fetched | null,
): CommandGroup[] {
  const terms = splitTerms(q);
  const local = groups.map(g => ({
    label: g.label,
    items: g.items.filter(it =>
      (!it.roles || (role !== null && it.roles.includes(role))) &&
      matchesTerms(terms, `${it.label} ${it.keywords ?? ""}`.toLowerCase())),
  }));
  const fresh = fetched?.q === q.trim();
  const found = fetched && terms.length > 0
    ? SEARCHED.map(([key, label]) => ({
        label,
        items: fresh ? fetched[key] : fetched[key].filter(it => {
          const hay = `${it.label} ${it.hint ?? ""}`.toLowerCase();
          return terms.every(t => hay.includes(t));
        }),
      }))
    : [];
  return [...local, ...found].filter(g => g.items.length > 0);
}

const Ctx = createContext<{ open: () => void } | null>(null);

export function useCommandPalette() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCommandPalette must be used within <CommandProvider>");
  return c;
}

/**
 * ⌘K command palette, opened by ⌘/Ctrl-K anywhere or the top-bar button. It
 * filters the static groups (actions, destinations) as you type and searches
 * feedback, accounts and initiatives on the server: debounced, and each new
 * query aborts the request before it, so the newest one wins. A combobox over
 * a grouped listbox: focus stays in the input, arrows move the active option
 * (aria-activedescendant), Enter runs it, Escape closes and puts focus back.
 * The role comes back with every search, so actions it can't take stay hidden
 * (until the first answer, every role-gated action is hidden).
 */
export function CommandProvider({ groups, children }: { groups: CommandGroup[]; children: ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [role, setRole] = useState<string | null>(null);
  const [fetched, setFetched] = useState<Fetched | null>(null);
  // Whatever had focus when the palette opened; it gets focus back on close.
  const returnFocus = useRef<HTMLElement | null>(null);
  const id = useId();

  const openPalette = useCallback(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setQ("");
    setActive(0);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    returnFocus.current?.focus();
    returnFocus.current = null;
  }, []);

  // ⌘/Ctrl-K toggles, even from a text field: a modifier chord can't be typed
  // by accident. With Shift or Alt it's some other shortcut, so it's left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "k" && e.key !== "K") || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.repeat || e.defaultPrevented) return;
      e.preventDefault();
      if (open) close();
      else openPalette();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, openPalette]);

  // Search. An empty query still asks once per open, to learn the role.
  const qt = q.trim();
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/v1/palette?q=${encodeURIComponent(qt)}`, { cache: "no-store", signal: ctrl.signal })
        .then(r => (r.ok ? (r.json() as Promise<PaletteResponse>) : Promise.reject(new Error(`palette ${r.status}`))))
        .then(d => {
          if (ctrl.signal.aborted) return;
          setRole(d.role);
          setFetched({ q: qt, feedback: d.feedback, accounts: d.accounts, initiatives: d.initiatives });
        })
        .catch(() => { if (!ctrl.signal.aborted) setFetched({ ...NONE, q: qt, failed: true }); });
    }, qt ? DEBOUNCE_MS : 0);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [open, qt]);

  const sections = paletteSections(groups, role, q, fetched);
  const options = sections.flatMap(s => s.items);
  const current = Math.min(active, options.length - 1); // -1 when nothing is listed
  const optionId = (i: number) => `${id}-opt-${i}`;
  const searching = qt !== "" && fetched?.q !== qt;
  const failed = qt !== "" && fetched?.q === qt && !!fetched.failed;
  const notice = failed
    ? "Couldn't search feedback, accounts or initiatives. Try again in a moment."
    : options.length > 0 ? null
    : searching ? "Searching…"
    : `No results for “${qt}”`;
  const announcement = !qt || searching
    ? ""
    : notice ?? `${options.length} ${options.length === 1 ? "result" : "results"}`;

  // Keep the active option in view as the arrows move it.
  useEffect(() => {
    if (open && current >= 0) document.getElementById(`${id}-opt-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [open, current, id]);

  function run(it: CommandItem | undefined) {
    if (!it) return;
    close();
    router.push(it.href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return; // the IME owns Enter and the arrows
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // close only the palette, not a dialog under it
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.max(0, Math.min(options.length - 1, current + 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(0, current - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(options[current]);
    } else if (e.key === "Tab") {
      e.preventDefault(); // the input is the dialog's only stop
    }
  }

  let n = -1;
  return (
    <Ctx.Provider value={{ open: openPalette }}>
      {children}
      {open && (
        <div className="cmdk-scrim" onClick={close}>
          <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette" onClick={e => e.stopPropagation()}>
            <div className="cmdk-input-row">
              <Ic.search aria-hidden="true" style={{ width: 15, height: 15, color: "var(--mute-2)", flexShrink: 0 }} />
              <input
                autoFocus
                className="cmdk-input"
                role="combobox"
                aria-expanded="true"
                aria-controls={`${id}-list`}
                aria-activedescendant={current >= 0 ? optionId(current) : undefined}
                aria-autocomplete="list"
                aria-label="Search feedback, accounts and initiatives, or jump to a page"
                placeholder="Search or jump to…"
                autoComplete="off"
                spellCheck={false}
                value={q}
                onChange={e => { setQ(e.target.value); setActive(0); }}
                onKeyDown={onKeyDown}
              />
              <span className="cmdk-esc" aria-hidden="true">esc</span>
            </div>
            <div className="cmdk-list" id={`${id}-list`} role="listbox" aria-label="Results">
              {sections.map((s, gi) => (
                <div key={s.label} role="presentation">
                  <div id={`${id}-g${gi}`} role="presentation" className="eyebrow" style={{ padding: "8px 10px 4px" }}>
                    {s.label}
                  </div>
                  <div role="group" aria-labelledby={`${id}-g${gi}`}>
                    {s.items.map(it => {
                      const i = ++n;
                      return (
                        <div
                          key={it.href}
                          id={optionId(i)}
                          role="option"
                          aria-selected={i === current}
                          className={`cmdk-opt ${i === current ? "active" : ""}`}
                          style={i === current ? ACTIVE : undefined}
                          onMouseMove={() => { if (i !== current) setActive(i); }}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => run(it)}
                        >
                          <span className="cmdk-opt-label">{it.label}</span>
                          {it.hint && <span className="cmdk-opt-hint">{it.hint}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {notice && <div className="cmdk-empty" role="presentation">{notice}</div>}
            </div>
            <div role="status" style={SR_ONLY}>{announcement}</div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

/** Top-bar trigger for the palette. */
export function CommandButton() {
  const { open } = useCommandPalette();
  return (
    <button
      type="button"
      className="cmdk-btn"
      data-tour="cmdk"
      onClick={open}
      aria-label="Search (Command-K)"
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
    >
      <Ic.search aria-hidden="true" style={{ width: 13, height: 13, opacity: 0.7 }} />
      <span className="cmdk-btn-kbd">⌘K</span>
    </button>
  );
}
