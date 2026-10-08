"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Btn } from "@crumb/ui";

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as a destructive (red) action. */
  destructive?: boolean;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

const ConfirmCtx = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

/**
 * Promise-based replacement for the browser's native confirm(). Resolves true
 * when the user confirms, false on cancel / Escape / scrim click. Used so call
 * sites keep the familiar `if (!(await confirm(...))) return;` control flow but
 * render a dialog that matches the design system instead of a browser chrome
 * popup.
 */
export function useConfirm() {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // Whatever had focus when the dialog opened (usually the trigger button).
  // Captured before render, since autoFocus moves focus during commit.
  const returnFocus = useRef<HTMLElement | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    return new Promise<boolean>(resolve => setPending({ ...opts, resolve }));
  }, []);

  const close = useCallback((ok: boolean) => {
    setPending(prev => {
      prev?.resolve(ok);
      return null;
    });
    returnFocus.current?.focus();
    returnFocus.current = null;
  }, []);

  // Escape cancels. Enter is left to the focused button, so Enter on Cancel
  // cancels (a window-level Enter used to confirm whatever had focus).
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, close]);

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {pending && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={pending.title}
          className="modal-scrim"
          onClick={() => close(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(28, 24, 21, 0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 60, padding: 24,
          }}
        >
          <div
            className="modal-card"
            onClick={e => e.stopPropagation()}
            style={{
              background: "var(--paper, var(--surface))",
              border: "1px solid var(--line, var(--hair))",
              borderRadius: "var(--r-md)",
              padding: 20,
              width: "min(420px, 100%)",
              boxShadow: "var(--sh-soft)",
            }}
          >
            <h3 className="serif" style={{ margin: "0 0 8px", fontSize: 17 }}>{pending.title}</h3>
            {pending.body && (
              <p className="text-sm muted" style={{ margin: "0 0 16px", lineHeight: 1.55 }}>{pending.body}</p>
            )}
            {/* Initial focus: Cancel on destructive confirms so a reflex Enter
                backs out, the primary action otherwise. */}
            <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
              <Btn autoFocus={!!pending.destructive} onClick={() => close(false)}>{pending.cancelLabel ?? "Cancel"}</Btn>
              <Btn
                autoFocus={!pending.destructive}
                variant={pending.destructive ? "danger" : "primary"}
                onClick={() => close(true)}
              >
                {pending.confirmLabel ?? "Confirm"}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}
