"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Ic, Pill } from "@crumb/ui";
import { markAllRead } from "@/app/(app)/notifications/actions";

type FeedDTO = {
  id: string;
  shortId: string;
  href: string;
  who: string;
  whoSub: string;
  what: string;
  item: string;
  age: string;
  unread: boolean;
  internal: boolean;
  mentioned: boolean;
};

/**
 * Top-bar notification bell. Replaces the old /notifications page: a badge with
 * the unread count + a popover listing recent activity. Polls the unread count
 * (paused when the tab is hidden) and fetches entries on open. Preferences live
 * in Settings → Notifications. Carries data-tour="notifs" for the tour.
 */
export function NotificationBell({ initialUnread = 0 }: { initialUnread?: number }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initialUnread);
  const [entries, setEntries] = useState<FeedDTO[] | null>(null);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  async function refresh(withEntries: boolean) {
    try {
      const res = await fetch("/api/v1/feed", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data.unread === "number") setUnread(data.unread);
      if (withEntries && Array.isArray(data.entries)) setEntries(data.entries);
    } catch {
      /* best-effort */
    }
  }

  // Load the unread count now, then poll it while the tab is visible.
  useEffect(() => {
    refresh(false);
    const id = setInterval(() => { if (!document.hidden) refresh(false); }, 60_000);
    const onVis = () => { if (!document.hidden) refresh(false); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setLoading(entries === null);
      refresh(true).finally(() => setLoading(false));
    }
  }

  async function onMarkAll() {
    setUnread(0);
    setEntries(es => (es ? es.map(e => ({ ...e, unread: false })) : es));
    try { await markAllRead(); } catch { /* best-effort */ }
  }

  return (
    <div ref={rootRef} className="bell">
      <button
        type="button"
        className="topbar-icon-btn"
        aria-label="Notifications"
        aria-expanded={open}
        data-tour="notifs"
        onClick={toggle}
      >
        <Ic.bell style={{ width: 16, height: 16 }} />
        {unread > 0 && <span className="bell-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>

      {open && (
        <div className="bell-pop" role="dialog" aria-label="Notifications">
          <div className="bell-head">
            <span className="fw-med text-sm">Notifications</span>
            <button
              type="button"
              className="link-back"
              onClick={onMarkAll}
              disabled={unread === 0}
              style={{ background: "none", border: 0, padding: 0, cursor: unread === 0 ? "default" : "pointer", fontSize: "var(--fs-xs)", opacity: unread === 0 ? 0.5 : 1 }}
            >
              Mark all read
            </button>
          </div>

          <div className="bell-list">
            {loading && <div className="bell-empty">Loading…</div>}
            {!loading && entries && entries.length === 0 && (
              <div className="bell-empty">You&apos;re all caught up.</div>
            )}
            {!loading && entries && entries.map(e => (
              <Link key={e.id} href={e.href} className="bell-row" onClick={() => setOpen(false)}>
                <span className="text-sm truncate" style={{ display: "block" }}>
                  <span className={e.unread ? "fw-med" : "muted"}>{e.who}</span>
                  {e.whoSub && <span className="muted"> · {e.whoSub}</span>}
                  <span className={e.mentioned ? "" : "muted"} style={e.mentioned ? { color: "var(--accent)", fontWeight: 500 } : undefined}> {e.what} </span>
                  <span className={e.unread ? "" : "muted"}>{e.item}</span>
                  {e.internal && <Pill style={{ marginLeft: 6 }}><Ic.lock style={{ width: 9, height: 9 }} />Internal</Pill>}
                </span>
                <span className="row between center" style={{ marginTop: 2 }}>
                  <span className="text-xs muted mono">{e.shortId}</span>
                  <span className="text-xs muted mono">{e.age}</span>
                </span>
              </Link>
            ))}
          </div>

          <Link href="/settings/notifications" className="bell-foot" onClick={() => setOpen(false)}>
            Notification settings →
          </Link>
        </div>
      )}
    </div>
  );
}
