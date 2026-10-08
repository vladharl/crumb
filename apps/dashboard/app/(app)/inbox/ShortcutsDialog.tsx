"use client";

import { useEffect, useRef } from "react";
import { Ic } from "@crumb/ui";
import { SHORTCUTS } from "./triage-keys";
import css from "./inbox.module.css";

/**
 * The `?` cheat sheet: every inbox shortcut. A modal dialog: focus moves in
 * on open and stays in (its one control is Close), Esc or the scrim closes
 * it, and focus goes back to wherever it was.
 */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "Tab") { e.preventDefault(); closeRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      back?.focus();
    };
  }, [onClose]);

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="inbox-shortcuts-title"
        className="sheet"
        onClick={e => e.stopPropagation()}
        style={{ padding: 20, width: "min(420px, 100%)" }}
      >
        <div className="row between center" style={{ marginBottom: 14 }}>
          <h3 id="inbox-shortcuts-title" className="serif" style={{ margin: 0, fontSize: 18 }}>Keyboard shortcuts</h3>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            className="rd-close"
            onClick={onClose}
          >
            <Ic.x style={{ width: 14, height: 14 }} />
          </button>
        </div>
        <dl className={css.keys}>
          {SHORTCUTS.map(s => (
            <div key={s.does} style={{ display: "contents" }}>
              <dt>{s.keys.map(k => <kbd key={k} className={css.kbd}>{k}</kbd>)}</dt>
              <dd>{s.does}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs muted" style={{ margin: "14px 0 0" }}>
          Shortcuts pause while you type in a field.
        </p>
      </div>
    </div>
  );
}
