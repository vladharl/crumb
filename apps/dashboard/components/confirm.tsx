"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Btn } from "@crumb/ui";
import { Dialog } from "@/components/Dialog";

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

  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>(resolve => setPending({ ...opts, resolve })),
    [],
  );

  // Close first, synchronously: the page is live again and focus is back on
  // the opener (Dialog) before the caller's `await confirm()` resumes.
  function settle(ok: boolean) {
    flushSync(() => setPending(null));
    pending?.resolve(ok);
  }

  // Escape and the scrim cancel (Dialog). Enter is left to the focused
  // button, so Enter on Cancel cancels (a window-level Enter used to confirm
  // whatever had focus).
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {pending && (
        <Dialog
          label={pending.title}
          onClose={() => settle(false)}
          scrimClassName="modal-scrim"
          scrimStyle={{
            position: "fixed", inset: 0, background: "var(--scrim, rgba(28, 24, 21, 0.45))",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 60, padding: 24,
          }}
          className="modal-card"
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
            <Btn autoFocus={!!pending.destructive} onClick={() => settle(false)}>{pending.cancelLabel ?? "Cancel"}</Btn>
            <Btn
              autoFocus={!pending.destructive}
              variant={pending.destructive ? "danger" : "primary"}
              onClick={() => settle(true)}
            >
              {pending.confirmLabel ?? "Confirm"}
            </Btn>
          </div>
        </Dialog>
      )}
    </ConfirmCtx.Provider>
  );
}
