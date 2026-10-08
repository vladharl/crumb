"use client";

import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from "react";

export type ToastAction = { label: string; onClick: () => void };

export type ToastOptions = {
  message: string;
  /** Optional single action, rendered as a button (e.g. "Undo"). */
  action?: ToastAction;
  /** "error" tints the toast with the rust error palette. */
  tone?: "default" | "error";
  /** Auto-dismiss after this many ms. Defaults to 6000 (8000 with an action). */
  duration?: number;
};

type Toast = ToastOptions & { id: number };

type ToastApi = {
  show: (opts: ToastOptions) => number;
  dismiss: (id: number) => void;
};

const ToastCtx = createContext<ToastApi | null>(null);

type Clock = { left: number; due: number; timer?: ReturnType<typeof setTimeout>; hover: boolean; focus: boolean };

/**
 * One auto-dismiss clock per toast. A clock stops while its toast is hovered
 * or holds focus (time to read it, or to reach Undo) and resumes with the
 * time it had left.
 */
export function toastClocks(expire: (id: number) => void) {
  const clocks = new Map<number, Clock>();
  const run = (id: number, c: Clock) => {
    c.due = Date.now() + c.left;
    c.timer = setTimeout(() => { clocks.delete(id); expire(id); }, c.left);
  };
  const stop = (id: number) => {
    clearTimeout(clocks.get(id)?.timer);
    clocks.delete(id);
  };
  return {
    start(id: number, ms: number) {
      const c: Clock = { left: ms, due: 0, hover: false, focus: false };
      clocks.set(id, c);
      run(id, c);
    },
    hold(id: number, why: "hover" | "focus", on: boolean) {
      const c = clocks.get(id);
      if (!c) return;
      c[why] = on;
      if (c.hover || c.focus) {
        if (!c.timer) return;
        clearTimeout(c.timer);
        c.timer = undefined;
        c.left = Math.max(0, c.due - Date.now());
      } else if (!c.timer) {
        run(id, c);
      }
    },
    stop,
    stopAll() { for (const id of [...clocks.keys()]) stop(id); },
  };
}

/**
 * Lightweight toast + undo surface. Built for the inbox's write path: bulk
 * status/assign and capture dismiss show a confirming toast with an "Undo"
 * action, and failures surface as an error-toned toast instead of failing
 * silently. Promise-free, on-brand (cream surface, ember action), and it
 * respects prefers-reduced-motion via the .toast CSS.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const [clocks] = useState(() => toastClocks(id => setToasts(prev => prev.filter(t => t.id !== id))));

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    clocks.stop(id);
  }, [clocks]);

  const show = useCallback((opts: ToastOptions) => {
    const id = ++seq.current;
    setToasts(prev => [...prev, { ...opts, id }]);
    clocks.start(id, opts.duration ?? (opts.action ? 8000 : 6000));
    return id;
  }, [clocks]);

  // Clear any outstanding timers on unmount.
  useEffect(() => () => clocks.stopAll(), [clocks]);

  return (
    <ToastCtx.Provider value={{ show, dismiss }}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`toast ${t.tone === "error" ? "err" : ""}`}
            // Errors are announced at once; the rest wait their turn (polite region).
            role={t.tone === "error" ? "alert" : undefined}
            onMouseEnter={() => clocks.hold(t.id, "hover", true)}
            onMouseLeave={() => clocks.hold(t.id, "hover", false)}
            onFocus={() => clocks.hold(t.id, "focus", true)}
            onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) clocks.hold(t.id, "focus", false); }}
          >
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => { t.action!.onClick(); dismiss(t.id); }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
