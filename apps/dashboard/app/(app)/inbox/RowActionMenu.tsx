"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Btn, Ic, REASON_PLACEHOLDER, REASON_REQUIRED, VENDOR_STATUS_OPTIONS, statusLabel } from "@crumb/ui";
import type { VendorStatus } from "@crumb/ui";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm";
import { cancelWaitingMove } from "@/components/ReplyComposer";
import { errorMessage } from "@/lib/action-error";
import { statusEmailsCustomer } from "@/lib/notify/customer-plan";
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

type Pane = "root" | "assign" | "status" | "initiative" | "reason";

// ── Status-write helpers, shared with the bulk bar in InboxTable ──────────

// Who a status that emails (statusEmailsCustomer) actually reaches: the
// pipeline only emails widget-origin submitters who haven't opted out, and
// nobody until a real email provider is set up (emailConfigured).
export function emailNote(count: number, emailConfigured: boolean): string {
  if (!emailConfigured) return "Email delivery isn't set up yet, so nobody gets emailed.";
  return count === 1
    ? "The submitter gets an email about this, unless they opted out or the item didn't come in through the widget."
    : "Submitters get an email about this, unless they opted out or their item didn't come in through the widget.";
}

type StatusResult = Awaited<ReturnType<typeof bulkUpdateStatus>>;

// What a status write actually did, as a toast: everything moved, nothing
// moved (the error), or some did (counts, then the first error). `name`
// labels a single row in place of the item count. Merged duplicates the write
// left out are named last: they follow the item they were merged into.
export function statusToast(r: StatusResult, label: string, name?: string): { message: string; tone?: "error" } {
  if (!r.ok) return { message: errorMessage(r.error), tone: "error" };
  const skipped = r.skipped ?? 0;
  if (skipped > 0 && r.affected === 0 && r.failed === 0) {
    return { message: name
      ? `${name} is merged into another item, so it follows that item's status.`
      : "Nothing moved. Merged duplicates follow the item they were merged into." };
  }
  const note = skipped === 0 ? ""
    : skipped === 1 ? " Skipped 1 merged duplicate. It follows the item it was merged into."
    : ` Skipped ${skipped} merged duplicates. They follow the items they were merged into.`;
  if (r.failed === 0) return { message: `${name ?? `${r.affected} ${r.affected === 1 ? "item" : "items"}`} moved to ${label}.${note}` };
  if (r.affected === 0) return { message: `${errorMessage(r.firstError)}${note}`, tone: "error" };
  return { message: `${r.affected} moved, ${r.failed} failed. ${errorMessage(r.firstError)}${note}`, tone: "error" };
}

/**
 * The "say why" step before a reason-required status, in the thread status
 * card's wording. The text lives here, so a failed write leaves it in place
 * for a retry; the parent unmounts the form once the write lands.
 */
export function ReasonForm({ status, count, emailConfigured, pending, onCancel, onSubmit }: {
  status: string;
  count: number;
  emailConfigured: boolean;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [text, setText] = useState("");
  const label = statusLabel(status);
  return (
    <div className="col gap-2" style={{ maxWidth: 520 }}>
      <span className="eyebrow">{label}: say why</span>
      <textarea
        className="input"
        rows={3}
        autoFocus
        aria-label={`Reason for ${label}`}
        placeholder={REASON_PLACEHOLDER[status]}
        value={text}
        onChange={e => setText(e.target.value)}
        disabled={pending}
      />
      {statusEmailsCustomer(status) && (
        <p className="note text-xs muted">
          {emailNote(count, emailConfigured)}{emailConfigured && " The email includes your reason."}
        </p>
      )}
      <div className="row gap-2">
        <Btn sm onClick={onCancel} disabled={pending}>Cancel</Btn>
        <Btn sm variant="primary" onClick={() => onSubmit(text.trim())} disabled={pending || !text.trim()}>
          {pending ? "Saving…" : count > 1 ? `Move ${count} items to ${label}` : `Move to ${label}`}
        </Btn>
      </div>
    </div>
  );
}

export function RowActionMenu({
  itemId, shortId, assigneeId, status, initiativeId, merged = false,
  assignees, initiatives, canWrite, canManageInitiatives, emailConfigured, onStatusOptimistic, onDelete,
}: {
  itemId: string;
  shortId: string;
  assigneeId: string | null;
  status: string;
  initiativeId: string | null;
  // A merged duplicate's status follows the item it was merged into, so the
  // menu doesn't offer one (bulkUpdateStatus skips duplicates).
  merged?: boolean;
  assignees: Assignee[];
  initiatives: InitiativeOption[];
  canWrite: boolean;
  canManageInitiatives: boolean;
  emailConfigured: boolean;
  // Lets the inbox paint a single-row status change on the same frame it's
  // chosen (optimistic overlay), reverting with `null` if the write fails.
  onStatusOptimistic?: (status: string | null) => void;
  // Admins only: delete or mark as spam. useDeleteItems confirms, hides the
  // row and offers Undo before anything is removed.
  onDelete?: (mode: "delete" | "spam") => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>("root");
  // The reason-required status the "reason" pane is asking a reason for.
  const [reasonFor, setReasonFor] = useState<VendorStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu is portaled to <body> (see render) so it escapes the row's
  // `row-interactive` stacking context and the inbox's overflow clip — hence it
  // needs viewport coords. null until first placed, to avoid a flash at 0,0.
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);

  function close() {
    // Choosing or leaving puts focus back on the ⋯ button, as a menu button does.
    if (menuRef.current?.contains(document.activeElement)) btnRef.current?.focus();
    setOpen(false);
    setPane("root");
    setReasonFor(null);
    setCopied(false);
  }

  // Anchor the fixed menu to the trigger, right-aligned, flipping above when it
  // would overflow the viewport bottom. Recomputed on open, pane change, and
  // scroll/resize so it stays glued to the row.
  const place = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const menuH = menuRef.current?.offsetHeight ?? 0;
    const below = b.bottom + 4;
    const flipUp = menuH > 0 && below + menuH > window.innerHeight - 8 && b.top - menuH - 4 > 8;
    setCoords({
      top: flipUp ? b.top - menuH - 4 : below,
      right: Math.max(8, window.innerWidth - b.right),
    });
  }, []);

  // Close on outside click + Escape (same idiom as Dropdown).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The menu is portaled outside rootRef, so check it too before closing —
      // otherwise a click on any menu option would dismiss before it fires.
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); btnRef.current?.focus(); }
    };
    const onReflow = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, place]);

  // Position before the browser paints, so the menu never flashes mis-placed.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, pane, place]);

  // Focus moves into the menu once it's placed (it is hidden until then), and
  // to the first option of each pane. The reason pane focuses its own textarea.
  const placed = coords !== null;
  useEffect(() => {
    if (!open || !placed || pane === "reason") return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open, pane, placed]);

  // Arrows, Home and End move between options; Tab leaves the menu. The menu
  // is portaled to <body>, so a plain Tab would jump to the end of the page.
  function onMenuKey(e: React.KeyboardEvent) {
    if (pane === "reason") return;
    if (e.key === "Tab") { e.preventDefault(); close(); return; }
    const opts = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (opts.length === 0) return;
    const i = opts.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown" ? opts[(i + 1) % opts.length]
      : e.key === "ArrowUp" ? opts[(i - 1 + opts.length) % opts.length]
      : e.key === "Home" ? opts[0]
      : e.key === "End" ? opts[opts.length - 1]
      : null;
    if (!next) return;
    e.preventDefault();
    next.focus();
  }

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        close();
        router.refresh();
      } else {
        toast.show({ message: errorMessage(r.error), tone: "error" });
      }
    });
  }

  // Status gets the optimistic path: the inbox repaints the row on this frame
  // (re-bucketing it, sliding it via FLIP), the menu closes, and the write
  // reconciles in the background — reverting the paint if it fails. A status
  // that needs a reason asks for it first, in the menu; one that emails the
  // customer confirms first, like the bulk bar.
  async function setStatus(next: VendorStatus) {
    if (next === status) { close(); return; }
    if (REASON_REQUIRED.has(next)) { setReasonFor(next); setPane("reason"); return; }
    close();
    if (statusEmailsCustomer(next)) {
      const label = statusLabel(next);
      btnRef.current?.focus(); // the dialog hands focus back to what had it: the ⋯ trigger
      if (!(await confirm({
        title: `Move ${shortId} to ${label}?`,
        body: emailNote(1, emailConfigured),
        confirmLabel: `Move to ${label}`,
      }))) return;
    }
    // This status wins over a drawer move still waiting out its undo window.
    cancelWaitingMove(shortId);
    onStatusOptimistic?.(next);
    startTransition(async () => {
      const r = await bulkUpdateStatus([itemId], next);
      if (r.ok && r.failed === 0) router.refresh();
      else onStatusOptimistic?.(null);
      toast.show(statusToast(r, statusLabel(next), shortId));
    });
  }

  // The reason path waits for the server instead: on a failure the pane stays
  // open with the typed reason, so nothing has to be retyped.
  function submitReason(reason: string) {
    if (!reasonFor) return;
    const next = reasonFor;
    cancelWaitingMove(shortId);
    startTransition(async () => {
      const r = await bulkUpdateStatus([itemId], next, reason);
      toast.show(statusToast(r, statusLabel(next), shortId));
      if (r.ok && r.failed === 0) {
        close();
        router.refresh();
      }
    });
  }

  function remove(mode: "delete" | "spam") {
    close();
    onDelete?.(mode);
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
    hint?: string;
  }) => (
    <button
      key={props.key ?? props.label}
      type="button"
      role="menuitem"
      className="dd-opt"
      disabled={pending}
      onClick={props.onClick}
    >
      <span className="dd-opt-label">{props.label}</span>
      {props.hint && <span className="text-2xs muted">{props.hint}</span>}
      {props.selected && <Ic.check className="dd-tick" />}
      {props.drill && <Ic.chevR style={{ width: 11, height: 11, flexShrink: 0, color: "var(--mute-2)" }} />}
    </button>
  );

  const backRow = (
    <button type="button" role="menuitem" className="dd-opt" onClick={() => setPane("root")} disabled={pending}>
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

      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          className="dd-menu"
          // The reason pane holds a form, which a menu can't.
          role={pane === "reason" ? "dialog" : "menu"}
          aria-label={`Actions for ${shortId}`}
          onKeyDown={onMenuKey}
          style={{
            position: "fixed",
            top: coords?.top ?? -9999,
            right: coords?.right ?? 8,
            left: "auto",
            bottom: "auto",
            minWidth: 190,
            zIndex: 80,
            visibility: coords ? "visible" : "hidden",
          }}
        >
          {pane === "root" && (
            <>
              {opt({ label: "Open thread", onClick: () => router.push(`/thread/${shortId}`) })}
              {opt({ label: copied ? "Copied" : "Copy link", onClick: copyLink })}
              {canWrite && opt({ label: "Assign to…", drill: true, onClick: () => setPane("assign") })}
              {canWrite && !merged && opt({ label: "Set status…", drill: true, onClick: () => setPane("status") })}
              {canManageInitiatives && initiatives.length > 0 &&
                opt({ label: "Move to initiative…", drill: true, onClick: () => setPane("initiative") })}
              {onDelete && opt({ label: "Mark as spam…", onClick: () => remove("spam") })}
              {onDelete && opt({ label: "Delete…", onClick: () => remove("delete") })}
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
              {/* The moves that email the customer say so, as in the thread. */}
              {VENDOR_STATUS_OPTIONS.map(s =>
                opt({
                  key: s.value,
                  label: s.label,
                  selected: s.value === status,
                  hint: emailConfigured && s.value !== status && statusEmailsCustomer(s.value) ? "emails" : undefined,
                  onClick: () => void setStatus(s.value),
                }),
              )}
            </>
          )}

          {pane === "reason" && reasonFor && (
            <div style={{ padding: 4 }}>
              <ReasonForm
                status={reasonFor}
                count={1}
                emailConfigured={emailConfigured}
                pending={pending}
                onCancel={() => setPane("status")}
                onSubmit={submitReason}
              />
            </div>
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
        </div>,
        document.body,
      )}
    </div>
  );
}
