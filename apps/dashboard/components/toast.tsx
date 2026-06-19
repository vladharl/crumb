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
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, []);

  const show = useCallback((opts: ToastOptions) => {
    const id = ++seq.current;
    setToasts(prev => [...prev, { ...opts, id }]);
    const duration = opts.duration ?? (opts.action ? 8000 : 6000);
    const timer = setTimeout(() => dismiss(id), duration);
    timers.current.set(id, timer);
    return id;
  }, [dismiss]);

  // Clear any outstanding timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => { for (const t of map.values()) clearTimeout(t); map.clear(); };
  }, []);

  return (
    <ToastCtx.Provider value={{ show, dismiss }}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.tone === "error" ? "err" : ""}`}>
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
