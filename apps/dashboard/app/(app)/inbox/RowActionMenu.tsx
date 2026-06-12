"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ic } from "@crumb/ui";
import type { Status } from "@crumb/ui";
import { bulkAssign, bulkUpdateStatus } from "./actions";
import { bulkSetInitiative } from "../initiatives/actions";
import type { Assignee, InitiativeOption } from "./InboxTable";

/**
 * Per-row "⋯" menu: the quick-triage actions for ONE item without the
 * checkbox→bulk-bar flow or opening the thread. Reuses the bulk server
 * actions with a single-id array, and the .dd-* popover tokens from the
 * shared Dropdown so it reads as the same component family.
 *
 * Drill-in panes (root ⇄ picker with a back row) instead of nested submenus —
 * one popover, no hover-intent timing problems.
 */

type Pane = "root" | "assign" | "status" | "initiative";

const STATUS_OPTIONS: Array<{ value: Status; label: string }> = [
  { value: "open",      label: "Open" },
  { value: "review",    label: "In review" },
  { value: "planned",   label: "Planned" },
  { value: "progress",  label: "In progress" },
  { value: "shipped",   label: "Shipped" },
  { value: "declined",  label: "Won’t ship" },
  { value: "deferred",  label: "Set aside" },
  { value: "duplicate", label: "Duplicate" },
];

export function RowActionMenu({
  itemId, shortId, assigneeId, status, initiativeId,
  assignees, initiatives, canWrite, canManageInitiatives,
}: {
  itemId: string;
  shortId: string;
  assigneeId: string | null;
  status: string;
  initiativeId: string | null;
  assignees: Assignee[];
  initiatives: InitiativeOption[];
  canWrite: boolean;
  canManageInitiatives: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>("root");
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
    setPane("root");
    setCopied(false);
  }

  // Close on outside click + Escape (same idiom as Dropdown).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); btnRef.current?.focus(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function run(fn: () => Promise<{ ok: boolean }>) {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        close();
        router.refresh();
      }
    });
  }

  function copyLink() {
    void navigator.clipboard?.writeText(`${window.location.origin}/thread/${shortId}`).catch(() => {});
    setCopied(true);
    window.setTimeout(close, 700);
  }

  const opt = (props: {
    key?: string;
    label: string;
    onClick: () => void;
    selected?: boolean;
    drill?: boolean;
  }) => (
    <button
      key={props.key ?? props.label}
      type="button"
      className="dd-opt"
      disabled={pending}
      onClick={props.onClick}
    >
      <span className="dd-opt-label">{props.label}</span>
      {props.selected && <Ic.check className="dd-tick" />}
      {props.drill && <Ic.chevR style={{ width: 11, height: 11, flexShrink: 0, color: "var(--mute-2)" }} />}
    </button>
  );

  const backRow = (
    <button type="button" className="dd-opt" onClick={() => setPane("root")} disabled={pending}>
      <Ic.chevR style={{ width: 11, height: 11, flexShrink: 0, color: "var(--mute-2)", transform: "rotate(180deg)" }} />
      <span className="dd-opt-label">Back</span>
    </button>
  );

  return (
    <div ref={rootRef} className="dd" style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={btnRef}
        type="button"
        aria-label={`Actions for ${shortId}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 24, height: 24, padding: 0,
          background: "none", border: "none", borderRadius: "var(--r-sm)",
          color: "var(--mute-2)", cursor: "pointer",
        }}
      >
        <Ic.more style={{ width: 14, height: 14 }} />
      </button>

      {open && (
        <div
          className="dd-menu"
          role="menu"
          aria-label={`Actions for ${shortId}`}
          style={{ right: 0, left: "auto", minWidth: 190, zIndex: 30 }}
        >
          {pane === "root" && (
            <>
              {opt({ label: "Open thread", onClick: () => router.push(`/thread/${shortId}`) })}
              {opt({ label: copied ? "Copied" : "Copy link", onClick: copyLink })}
              {canWrite && opt({ label: "Assign to…", drill: true, onClick: () => setPane("assign") })}
              {canWrite && opt({ label: "Set status…", drill: true, onClick: () => setPane("status") })}
              {canManageInitiatives && initiatives.length > 0 &&
                opt({ label: "Move to initiative…", drill: true, onClick: () => setPane("initiative") })}
            </>
          )}

          {pane === "assign" && (
            <>
              {backRow}
              {opt({ key: "__unassign", label: "Unassign", selected: assigneeId === null, onClick: () => run(() => bulkAssign([itemId], null)) })}
              {assignees.map(a =>
                opt({ key: a.id, label: a.name, selected: a.id === assigneeId, onClick: () => run(() => bulkAssign([itemId], a.id)) }),
              )}
            </>
          )}

          {pane === "status" && (
            <>
              {backRow}
              {STATUS_OPTIONS.map(s =>
                opt({ key: s.value, label: s.label, selected: s.value === status, onClick: () => run(() => bulkUpdateStatus([itemId], s.value)) }),
              )}
            </>
          )}

          {pane === "initiative" && (
            <>
              {backRow}
              {opt({ key: "__clear", label: "No initiative", selected: initiativeId === null, onClick: () => run(() => bulkSetInitiative([itemId], null)) })}
              {initiatives.map(i =>
                opt({ key: i.id, label: i.name, selected: i.id === initiativeId, onClick: () => run(() => bulkSetInitiative([itemId], i.id)) }),
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
