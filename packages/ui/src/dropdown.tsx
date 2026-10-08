"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Ic } from "./icons";

export type DropdownOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type DropdownProps = {
  value: string | null;
  onChange: (value: string) => void;
  options: DropdownOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** Show a filter box inside the menu. Implied by allowCreate. */
  searchable?: boolean;
  /** Offer a "Create '<typed>'" row when the query matches nothing. */
  allowCreate?: boolean;
  onCreate?: (text: string) => void;
  size?: "sm";
  className?: string;
  buttonStyle?: CSSProperties;
  /** Menu min-width matches the trigger by default; override if needed. */
  menuStyle?: CSSProperties;
};

/**
 * The trigger's accessible name: the label and the current value ("Status:
 * In review"), so a screen reader hears both. With nothing picked the
 * placeholder stands in, unless it only restates the label ("Set status…").
 */
export function dropdownName(ariaLabel: string | undefined, picked: string | null, placeholder: string): string | undefined {
  if (!ariaLabel) return undefined;
  const bare = (s: string) => s.replace(/[.…\s]+$/, "").toLowerCase();
  const shown = picked ?? (bare(ariaLabel).includes(bare(placeholder)) ? null : placeholder);
  return shown ? `${ariaLabel}: ${shown}` : ariaLabel;
}

/** The next enabled row after `from` going `dir`; `from` itself when there is none. */
export function nextEnabled(rows: ReadonlyArray<{ disabled?: boolean }>, from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (!rows[i].disabled) return i;
  return from;
}

/**
 * Accessible select replacement styled in Crumb's design language. A button
 * trigger, named by its label and value, opens a listbox popover (reusing the
 * .dd-* tokens in globals.css). Opening moves focus into the menu: the filter
 * box when there is one, else the listbox, both tracking the active row with
 * aria-activedescendant. Keyboard: arrows (open, then move), Home/End,
 * Enter/Space to pick, Escape, Tab; click-outside closes; flips up near the
 * viewport bottom. Optionally searchable / create-new (combobox-lite).
 *
 * This is a client component — import it into client components only.
 */
export function Dropdown({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
  ariaLabel,
  searchable = false,
  allowCreate = false,
  onCreate,
  size,
  className,
  buttonStyle,
  menuStyle,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  // -1: the first enabled row (a fresh menu, or a new filter).
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState("");
  const [flip, setFlip] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const showSearch = searchable || allowCreate;
  const q = query.trim().toLowerCase();
  const filtered = showSearch && q
    ? options.filter(o => o.label.toLowerCase().includes(q))
    : options;
  const selected = options.find(o => o.value === value) ?? null;
  const canCreate =
    allowCreate && !!query.trim() &&
    !options.some(o => o.label.toLowerCase() === q);
  // What the arrows walk: the matches, then the "Create …" row when offered.
  const rows: ReadonlyArray<{ disabled?: boolean }> = canCreate ? [...filtered, {}] : filtered;
  const at = active >= 0 && active < rows.length ? active : nextEnabled(rows, -1, 1);
  const listId = `${id}-list`;
  const optId = (i: number) => `${id}-opt-${i}`;
  const activeId = open && at >= 0 ? optId(at) : undefined;

  function openMenu() {
    // Start on the current value; -1 (nothing picked) starts on the first row.
    setActive(options.findIndex(o => o.value === value && !o.disabled));
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setQuery("");
    setActive(-1);
    btnRef.current?.focus();
  }

  function choose(o: DropdownOption) {
    if (o.disabled) return;
    onChange(o.value);
    close();
  }

  function create() {
    if (canCreate && onCreate) {
      onCreate(query.trim());
      close();
    }
  }

  function pick(i: number) {
    if (i < 0) return;
    if (i < filtered.length) choose(filtered[i]);
    else create();
  }

  // Scrolls the menu, never the page, so row i shows.
  function reveal(i: number) {
    const row = i >= 0 ? document.getElementById(optId(i)) : null;
    const box = menuRef.current;
    if (!row || !box) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
    }
  }

  // A keyboard move keeps the active row in view (the pointer's already is).
  function moveTo(i: number) {
    setActive(i);
    reveal(i);
  }

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
        setActive(-1);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Flip up when there isn't room below.
  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setFlip(window.innerHeight - r.bottom < 280 && r.top > 280);
  }, [open]);

  // Opening moves focus into the menu and brings the current value into view.
  useEffect(() => {
    if (!open) return;
    (showSearch ? searchRef.current : listRef.current)?.focus({ preventScroll: true });
    reveal(at);
    // Only on open: later moves scroll themselves (moveTo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showSearch]);

  function onKey(e: ReactKeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    // In the filter box, Space, Home and End belong to the text.
    const typing = e.target === searchRef.current;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation(); // don't also close a parent modal
        close();
        break;
      case "ArrowDown":
        e.preventDefault();
        moveTo(nextEnabled(rows, at, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        moveTo(nextEnabled(rows, at, -1));
        break;
      case "Home":
      case "End":
        if (typing) break;
        e.preventDefault();
        moveTo(e.key === "Home" ? nextEnabled(rows, -1, 1) : nextEnabled(rows, rows.length, -1));
        break;
      case " ":
        if (typing) break;
        e.preventDefault();
        pick(at);
        break;
      case "Enter":
        e.preventDefault();
        pick(at);
        break;
      case "Tab":
        close();
        break;
    }
  }

  return (
    <div
      ref={rootRef}
      className={`dd ${className ?? ""}`}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        ref={btnRef}
        type="button"
        className={`dd-trigger ${size === "sm" ? "sm" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={dropdownName(ariaLabel, selected?.label ?? null, placeholder)}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKey}
        style={buttonStyle}
      >
        <span className={`dd-value ${selected ? "" : "dd-ph"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <Ic.chevD className="dd-chev" />
      </button>

      {open && (
        <div
          ref={menuRef}
          className={`dd-menu ${flip ? "up" : ""}`}
          style={menuStyle}
          onKeyDown={onKey}
        >
          {showSearch && (
            <input
              ref={searchRef}
              className="input dd-search"
              role="combobox"
              aria-label="Search options"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              value={query}
              placeholder="Search…"
              onChange={e => { setQuery(e.target.value); setActive(-1); }}
            />
          )}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            aria-activedescendant={showSearch ? undefined : activeId}
            tabIndex={-1}
            // The active row is the focus mark (.dd-opt.active), not a ring
            // round the whole list.
            style={{ display: "flex", flexDirection: "column", gap: 1, outline: "none" }}
          >
            {filtered.map((o, i) => (
              <button
                key={o.value}
                id={optId(i)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={o.value === value}
                className={`dd-opt ${i === at ? "active" : ""}`}
                disabled={o.disabled}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o)}
              >
                <span className="dd-opt-label">{o.label}</span>
                {o.value === value && <Ic.check className="dd-tick" />}
              </button>
            ))}
            {canCreate && (
              <button
                id={optId(filtered.length)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={false}
                className={`dd-opt dd-create ${at === filtered.length ? "active" : ""}`}
                onMouseEnter={() => setActive(filtered.length)}
                onClick={create}
              >
                <Ic.plus className="dd-tick" />
                <span className="dd-opt-label">Create “{query.trim()}”</span>
              </button>
            )}
          </div>
          {filtered.length === 0 && !canCreate && (
            <div className="dd-empty">No matches</div>
          )}
        </div>
      )}
    </div>
  );
}
