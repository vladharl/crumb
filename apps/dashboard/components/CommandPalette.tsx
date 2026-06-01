"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { Ic } from "@crumb/ui";

export type CommandItem = {
  label: string;
  href: string;
  hint?: string;
  keywords?: string;
};

const Ctx = createContext<{ open: () => void } | null>(null);

export function useCommandPalette() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCommandPalette must be used within <CommandProvider>");
  return c;
}

/**
 * ⌘K command palette for jumping around the app. Opened by ⌘/Ctrl-K globally or
 * the top-bar search button. Filters a flat list of destinations; Arrow/Enter
 * navigates, Escape closes. Modal overlay mirrors the confirm.tsx idiom.
 */
export function CommandProvider({ items, children }: { items: CommandItem[]; children: ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const openPalette = useCallback(() => { setQ(""); setActive(0); setOpen(true); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setQ("");
        setActive(0);
        setOpen(o => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter(it => `${it.label} ${it.keywords ?? ""}`.toLowerCase().includes(s));
  }, [q, items]);

  function go(it: CommandItem | undefined) {
    if (!it) return;
    setOpen(false);
    router.push(it.href);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(filtered.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); go(filtered[active]); }
  }

  return (
    <Ctx.Provider value={{ open: openPalette }}>
      {children}
      {open && (
        <div className="cmdk-scrim" onClick={() => setOpen(false)}>
          <div className="cmdk" role="dialog" aria-label="Command palette" onClick={e => e.stopPropagation()}>
            <div className="cmdk-input-row">
              <Ic.search style={{ width: 15, height: 15, color: "var(--mute-2)", flexShrink: 0 }} />
              <input
                ref={inputRef}
                className="cmdk-input"
                placeholder="Jump to…"
                value={q}
                onChange={e => { setQ(e.target.value); setActive(0); }}
                onKeyDown={onKey}
              />
              <span className="cmdk-esc">esc</span>
            </div>
            <div className="cmdk-list">
              {filtered.length === 0 && <div className="cmdk-empty">No matches</div>}
              {filtered.map((it, i) => (
                <button
                  key={it.href}
                  type="button"
                  className={`cmdk-opt ${i === active ? "active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(it)}
                >
                  <span className="cmdk-opt-label">{it.label}</span>
                  {it.hint && <span className="cmdk-opt-hint">{it.hint}</span>}
                </button>
              ))}
            </div>
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
    <button type="button" className="cmdk-btn" data-tour="cmdk" onClick={open} aria-label="Search (Command-K)">
      <Ic.search style={{ width: 13, height: 13, opacity: 0.7 }} />
      <span className="cmdk-btn-kbd">⌘K</span>
    </button>
  );
}
