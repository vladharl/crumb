"use client";

import {
  useEffect,
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
 * Accessible select replacement styled in Crumb's design language. A button
 * trigger opens a listbox popover (reusing the .dd-* tokens in globals.css).
 * Keyboard: Arrow/Enter/Escape/Tab; click-outside closes; flips up near the
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
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const [flip, setFlip] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const showSearch = searchable || allowCreate;
  const q = query.trim().toLowerCase();
  const filtered = showSearch && q
    ? options.filter(o => o.label.toLowerCase().includes(q))
    : options;
  const selected = options.find(o => o.value === value) ?? null;
  const canCreate =
    allowCreate && !!query.trim() &&
    !options.some(o => o.label.toLowerCase() === q);
  const rowCount = filtered.length + (canCreate ? 1 : 0);

  function close() {
    setOpen(false);
    setQuery("");
    setActive(0);
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

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
        setActive(0);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Flip up when there isn't room below; focus the search box on open.
  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setFlip(window.innerHeight - r.bottom < 280 && r.top > 280);
  }, [open]);
  useEffect(() => {
    if (open && showSearch) searchRef.current?.focus();
  }, [open, showSearch]);

  function onKey(e: ReactKeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // don't also close a parent modal
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(a => Math.min(rowCount - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(a => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active < filtered.length) { const o = filtered[active]; if (o) choose(o); }
      else create();
    } else if (e.key === "Tab") {
      close();
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
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
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
          className={`dd-menu ${flip ? "up" : ""}`}
          role="listbox"
          aria-label={ariaLabel}
          style={menuStyle}
          onKeyDown={onKey}
        >
          {showSearch && (
            <input
              ref={searchRef}
              className="input dd-search"
              value={query}
              placeholder="Search…"
              onChange={e => { setQuery(e.target.value); setActive(0); }}
            />
          )}
          {filtered.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`dd-opt ${i === active ? "active" : ""}`}
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
              type="button"
              className={`dd-opt dd-create ${active === filtered.length ? "active" : ""}`}
              onMouseEnter={() => setActive(filtered.length)}
              onClick={create}
            >
              <Ic.plus className="dd-tick" />
              <span className="dd-opt-label">Create “{query.trim()}”</span>
            </button>
          )}
          {filtered.length === 0 && !canCreate && (
            <div className="dd-empty">No matches</div>
          )}
        </div>
      )}
    </div>
  );
}
