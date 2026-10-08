"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar, Btn, Ic, StatusDot, CLOSED_STATUSES, statusLabel } from "@crumb/ui";
import type { VendorStatus } from "@crumb/ui";
import { createReply, draftReplyAction, replyAndSetStatus, updateStatus } from "@/app/(app)/thread/[shortId]/actions";
import { errorMessage } from "@/lib/action-error";
import { statusEmailsCustomer, type NotifyPlan } from "@/lib/notify/customer-plan";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";

export type ComposerAttachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

export type ComposerTeammate = { id: string; name: string; initials: string };

// Whether a reply / a status change will email the item's submitter
// (customerNotifyPlan, computed server-side where the email config lives).
export type ItemNotifyPlan = { replies: NotifyPlan; status: NotifyPlan };

type Mode = "reply" | "note";

function humanBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ── Copy: what the customer will (and won't) get ─────────────

// Where an item came in, for the thread's "via Zendesk" and the no-email copy.
const SOURCE_LABELS: Record<string, string> = {
  widget: "the widget", email: "email", slack: "Slack", extension: "the browser extension",
  gong: "Gong", zendesk: "Zendesk", intercom: "Intercom", freshdesk: "Freshdesk", freshchat: "Freshchat",
  mcp: "an AI assistant (MCP)",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "the customer";
}

// Why the customer won't be emailed, or null when they will. `kind` names the
// emails a per-kind mute turned off.
export function noEmailNote(plan: NotifyPlan, kind: "reply" | "status", first: string, source: string | null): string | null {
  if (plan.willEmail) return null;
  switch (plan.reason) {
    // An AI assistant logged it for the team: there's no conversation to follow up in.
    case "source":         return `This came in through ${source ? sourceLabel(source) : "another tool"}, so ${first} won't be emailed.${source === "mcp" ? "" : " Follow up there too."}`;
    case "no_email":       return `There's no email address for ${first}, so nothing gets emailed.`;
    case "unsubscribed":   return `${first} unsubscribed from email, so nothing gets emailed.`;
    case "muted":          return `${first} turned off ${kind} emails, so nothing gets emailed.`;
    case "not_configured": return `Email delivery isn't set up yet, so ${first} won't be emailed.`;
  }
}

// The line beside the Reply / Internal note switch, in reply mode.
export function replyNote(plan: NotifyPlan, first: string, accountName: string, source: string | null): string {
  return noEmailNote(plan, "reply", first, source) ?? `Replying to ${first} at ${accountName}. They'll get this by email.`;
}

export function replySentMessage(emailed: boolean, first: string, closedAs?: string): string {
  return emailed
    ? `Reply sent to ${first} by email${closedAs ? `, and marked ${statusLabel(closedAs)}` : ""}.`
    : `Reply posted${closedAs ? ` and marked ${statusLabel(closedAs)}` : ""}. ${first} wasn't emailed.`;
}

// Will moving the item from `current` to `status` email anyone? The server's
// own rule (statusEmailsCustomer), gated by the submitter's plan, or reaching
// the customers whose requests were merged into this one (`others`, from
// mergedReach: the outcome email goes to them too, reason included).
export function statusWillEmail(status: string, current: string, plan: NotifyPlan, others = 0): boolean {
  return status !== current && statusEmailsCustomer(status) && (plan.willEmail || others > 0);
}

const othersWhoAsked = (n: number) => (n === 1 ? "1 other who asked" : `${n} others who asked`);

// Who a status email reaches: "Maya", "Maya and 2 others who asked", or just
// "2 others who asked" when Maya's own plan doesn't email her.
export function statusEmailees(first: string, submitter: boolean, others: number): string {
  if (others === 0) return first;
  return submitter ? `${first} and ${othersWhoAsked(others)}` : othersWhoAsked(others);
}

// Under a reason box: the reason goes to this item's customer only; people
// whose requests were merged in get the status without it.
export function reasonNote(first: string, submitter: boolean, others: number): string | null {
  if (others === 0) return null;
  const verb = others === 1 ? "gets" : "get";
  return submitter
    ? `Your reason is emailed to ${first} only. ${othersWhoAsked(others)} ${verb} the status without it.`
    : `${othersWhoAsked(others)} ${verb} the status email without your reason.`;
}

export function statusMovedMessage(status: string, first: string, emailed: boolean, othersEmailed = 0): string {
  const done = `Marked ${statusLabel(status)}.`;
  if (!statusEmailsCustomer(status)) return done;
  if (othersEmailed === 0) return `${done} ${first} ${emailed ? "was" : "wasn't"} emailed.`;
  return emailed
    ? `${done} ${statusEmailees(first, true, othersEmailed)} were emailed.`
    : `${done} ${othersWhoAsked(othersEmailed)} ${othersEmailed === 1 ? "was" : "were"} emailed. ${first} wasn't.`;
}

// ── Actions: errors, and a beat to undo status emails ────────

type Toasts = ReturnType<typeof useToast>;

// Calls a server action. A failure (an error code, or a throw) becomes an error
// toast and returns null, so the caller can roll back.
export async function runAction<R extends { ok: boolean }>(
  toast: Toasts,
  call: () => Promise<R>,
): Promise<Extract<R, { ok: true }> | null> {
  try {
    const res = await call();
    if (res.ok) return res as Extract<R, { ok: true }>;
    toast.show({ message: errorMessage((res as { error?: string }).error), tone: "error" });
  } catch {
    toast.show({ message: errorMessage(null), tone: "error" });
  }
  return null;
}

export const STATUS_EMAIL_DELAY_MS = 6000;

// Calls `send` after `ms` unless undone first; undo() says whether it stopped
// the send in time, flush() sends now if it's still waiting. Hiding or leaving
// the page sends at once: a background tab may never run the timer, and a
// closed one drops it.
export function sendAfterDelay(send: () => void, ms: number): { undo: () => boolean; flush: () => void } {
  let waiting = true;
  const onHide = () => { if (document.visibilityState === "hidden") flush(); };
  const stop = () => {
    waiting = false;
    clearTimeout(timer);
    window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", onHide);
  };
  function flush() {
    if (!waiting) return;
    stop();
    send();
  }
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", onHide);
  const timer = setTimeout(flush, ms);
  return {
    undo: () => {
      if (!waiting) return false;
      stop();
      return true;
    },
    flush,
  };
}

// Moves still inside their undo window, by item. Every other status change
// for the item drops the waiting one first (cancelWaitingMove), so a late
// commit never overwrites a status set meanwhile with another control.
const waitingMoves = new Map<string, () => void>();

/** Drops the item's status move still waiting to send, if any. */
export function cancelWaitingMove(itemShortId: string): void {
  waitingMoves.get(itemShortId)?.();
}

/**
 * Status moves for one item, shared by the thread's Status card and the inbox
 * drawer. A move that will email anyone (the submitter, or the customers whose
 * requests were merged into it) shows at once but waits STATUS_EMAIL_DELAY_MS
 * behind an Undo toast before anything is sent, and Shipped asks first. Other
 * moves apply right away. A failed write rolls the shown status back and says
 * why. A waiting move sends at once when the page is hidden or this component
 * unmounts, and never once another status change for the item has started.
 */
export function useStatusMove({ itemShortId, status, first, source, plan, mergedReach = 0, onMoved }: {
  itemShortId: string;
  status: string;          // the server's status
  first: string;           // the submitter's first name
  source: string | null;
  plan: NotifyPlan;        // the submitter's status-email plan
  mergedReach?: number;    // merged requesters an outcome email also reaches (mergedReach)
  onMoved?: (status: VendorStatus) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const waiting = useRef<{ undo: () => boolean; flush: () => void; toastId: number } | null>(null);
  const movedRef = useRef(onMoved);
  movedRef.current = onMoved;

  // The refreshed server status caught up: retire the overlay.
  useEffect(() => { setOptimistic(o => (o === status ? null : o)); }, [status]);

  // Leaving (another page, a collapsed drawer) sends a waiting move now,
  // rather than on a timer nothing is left to undo it from.
  useEffect(() => () => waiting.current?.flush(), [itemShortId]);

  // Drops the move waiting to send, if any; true when it stopped in time.
  function dropWaiting(): boolean {
    const w = waiting.current;
    if (!w) return false;
    waiting.current = null;
    waitingMoves.delete(itemShortId);
    toast.dismiss(w.toastId);
    return w.undo();
  }

  async function commit(next: VendorStatus, reason?: string) {
    setSaving(true);
    const res = await runAction(toast, () => updateStatus({ itemShortId, status: next, reason }));
    setSaving(false);
    if (!res) { setOptimistic(null); return; }
    router.refresh();
    toast.show({ message: statusMovedMessage(next, first, res.emailed, res.mergedEmailed) });
    movedRef.current?.(next);
  }

  const who = statusEmailees(first, plan.willEmail, mergedReach);
  const undone = `Undone. ${mergedReach > 0 ? "Nobody was" : `${first} wasn't`} emailed.`;

  async function move(next: VendorStatus, reason?: string) {
    if (next === (optimistic ?? status)) return;
    // Back to where the server already is: that's an undo, nothing to write.
    if (next === status) {
      if (dropWaiting()) toast.show({ message: undone });
      setOptimistic(null);
      return;
    }
    const emails = statusWillEmail(next, status, plan, mergedReach);
    if (next === "shipped" && !(await confirm({
      title: "Mark this Shipped?",
      // Why the submitter isn't emailed (if they aren't), then who is.
      body: [noEmailNote(plan, "status", first, source), emails && `${who} will get an email saying it shipped.`]
        .filter(Boolean).join(" "),
      confirmLabel: "Mark Shipped",
    }))) return;
    // The latest choice wins: an earlier move still waiting, from here or
    // another control, never sends.
    cancelWaitingMove(itemShortId);
    setOptimistic(next);
    if (!emails) { await commit(next, reason); return; }

    const pending = sendAfterDelay(() => {
      // Sending, on time or early (page hidden or left): Undo is over.
      const w = waiting.current;
      waiting.current = null;
      waitingMoves.delete(itemShortId);
      if (w) toast.dismiss(w.toastId);
      void commit(next, reason);
    }, STATUS_EMAIL_DELAY_MS);
    const toastId = toast.show({
      message: `Marked ${statusLabel(next)}. Emailing ${who} in ${STATUS_EMAIL_DELAY_MS / 1000} seconds.`,
      duration: STATUS_EMAIL_DELAY_MS,
      action: {
        label: "Undo",
        onClick: () => {
          if (waiting.current?.toastId !== toastId || !dropWaiting()) return;
          setOptimistic(null);
          toast.show({ message: undone });
        },
      },
    });
    waiting.current = { ...pending, toastId };
    waitingMoves.set(itemShortId, () => { if (dropWaiting()) setOptimistic(null); });
  }

  return { shown: optimistic ?? status, saving, move };
}

// The mode an unsent inbox draft was written in, so a draft restored into a
// re-opened drawer never changes audience. Lives as long as the tab does; the
// drafts themselves are kept by the inbox.
const draftModes = new Map<string, Mode>();

// The mode a switch of the conversation's tab selects (Internal picks a note,
// Customer a reply, or a note for viewers, who can't reply), or null when the
// tab didn't change, so a restored draft keeps its audience.
export function modeForTabChange(prev: Mode | undefined, next: Mode | undefined, canWrite: boolean): Mode | null {
  if (!next || next === prev) return null;
  return canWrite ? next : "note";
}

/**
 * The reply / internal-note composer, shared by the thread and the inbox's
 * reply-in-place drawer (same @-mention autocomplete, attachments, AI draft,
 * and send semantics). Who a message reaches is the Reply / Internal note
 * switch (Reply by default). Switching the conversation to its Internal tab
 * flips it to Internal note, and back to Customer flips it to Reply (tabMode);
 * the switch can still be flipped by hand. The send button says the
 * consequence: "Send to Maya", or "Add note". The line beside the switch
 * says whether the customer will actually be emailed, from the same plan the
 * server sends by. Owns its draft + send state and toasts the outcome; the
 * parent is told when something lands (onSent, with the status it closed as).
 *
 * Draft persistence (defaultDraft + onDraftChange) lets the inbox keep an
 * unsent draft alive across a collapse without keeping the drawer mounted.
 */
export function ReplyComposer({
  itemShortId,
  status,
  submitterName,
  accountName,
  source,
  notifyPlan,
  teammates,
  aiReplyAvailable,
  canWrite,
  onSent,
  autoFocus = false,
  defaultDraft = "",
  onDraftChange,
  framed = true,
  tabMode,
}: {
  itemShortId: string;
  // The item's status as shown; reply-and-close is offered only while open.
  status: string;
  submitterName: string;
  accountName: string;
  source: string | null;
  notifyPlan: ItemNotifyPlan;
  teammates: ComposerTeammate[];
  aiReplyAvailable: boolean;
  canWrite: boolean;
  onSent?: (closedAs?: "shipped" | "declined") => void;
  autoFocus?: boolean;
  defaultDraft?: string;
  onDraftChange?: (value: string) => void;
  // `framed` (default) gives the thread's card-foot treatment; the inbox drawer
  // passes false for a borderless inset that the drawer's own padding frames.
  framed?: boolean;
  // The mode the conversation's active tab stands for ("note" on Internal,
  // "reply" on Customer, undefined on a tab without a composer).
  tabMode?: Mode;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const noteId = useId();
  const first = firstName(submitterName);
  // Viewers can only post notes, so they start there, as does a composer that
  // opens on the Internal tab.
  const [mode, setModeState] = useState<Mode>(
    () => (!canWrite || tabMode === "note" ? "note" : (defaultDraft && draftModes.get(itemShortId)) || "reply"),
  );
  const isNote = mode === "note";
  const [draft, setDraftState] = useState(defaultDraft);
  const [sending, setSending] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<ComposerAttachment[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [drafting, setDrafting] = useState(false);

  // Single setter so every draft mutation also notifies the parent (for the
  // inbox's per-row draft persistence). Thread callers omit onDraftChange.
  const setDraft = (value: string) => {
    setDraftState(value);
    onDraftChange?.(value);
  };

  // ── @-mention autocomplete (internal notes only) ──
  const taRef = useRef<HTMLTextAreaElement>(null);
  const caretAfter = useRef<number | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);

  const setMode = (m: Mode) => {
    setModeState(m);
    setMention(null);
  };

  // Follow the conversation's tab when it changes (see modeForTabChange).
  const lastTab = useRef(tabMode);
  useEffect(() => {
    const next = modeForTabChange(lastTab.current, tabMode, canWrite);
    if (tabMode) lastTab.current = tabMode;
    if (next) setMode(next);
  }, [tabMode, canWrite]);

  // Keep the mode next to the inbox's persisted draft (see draftModes).
  const persisted = !!onDraftChange;
  useEffect(() => {
    if (!persisted) return;
    if (draft) draftModes.set(itemShortId, mode);
    else draftModes.delete(itemShortId);
  }, [persisted, draft, mode, itemShortId]);

  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return teammates.filter(t => t.name.toLowerCase().startsWith(q)).slice(0, 6);
  }, [mention, teammates]);

  // Detect an in-progress "@query" at the caret: an @ at line/word start, where
  // the text after it is a prefix of at least one teammate name.
  function detectMention(value: string, caret: number) {
    if (!isNote) { setMention(null); return; }
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at < 0) { setMention(null); return; }
    if (at > 0 && !/\s/.test(value[at - 1]!)) { setMention(null); return; }
    const query = upto.slice(at + 1);
    if (query.includes("\n")) { setMention(null); return; }
    const ql = query.toLowerCase();
    const isPrefix = teammates.some(t => t.name.toLowerCase().startsWith(ql));
    if (!isPrefix) { setMention(null); return; }
    setMention({ start: at, query });
    setMentionIdx(0);
  }

  function onDraftInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setDraft(e.target.value);
    detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
  }

  function pickMention(t: { id: string; name: string }) {
    if (!mention) return;
    const caret = taRef.current?.selectionStart ?? draft.length;
    const next = draft.slice(0, mention.start) + `@${t.name} ` + draft.slice(caret);
    caretAfter.current = mention.start + t.name.length + 2; // after "@Name "
    setDraft(next);
    setMention(null);
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!mention || mentionMatches.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx(i => (i + 1) % mentionMatches.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx(i => (i - 1 + mentionMatches.length) % mentionMatches.length); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mentionMatches[Math.min(mentionIdx, mentionMatches.length - 1)]!); }
    else if (e.key === "Escape") { e.preventDefault(); setMention(null); }
  }

  // Restore the caret after a programmatic mention insertion.
  useEffect(() => {
    if (caretAfter.current != null && taRef.current) {
      const pos = caretAfter.current;
      caretAfter.current = null;
      taRef.current.focus();
      taRef.current.setSelectionRange(pos, pos);
    }
  }, [draft]);

  async function pickAndUpload() {
    setUploadError(null);
    // Spin up a hidden <input type="file"> on-demand so we don't clutter the
    // DOM with a permanently-mounted picker.
    const input = document.createElement("input");
    input.type = "file";
    // Single file per reply for v1 — keep the UX simple.
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/v1/uploads", { method: "POST", body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setUploadError(data?.error || "Couldn't attach that file. Try again.");
        } else {
          setPendingAttachments(prev => [...prev, {
            id: data.id,
            filename: data.filename,
            contentType: data.content_type,
            sizeBytes: data.size_bytes,
          }]);
        }
      } catch (err) {
        setUploadError("Couldn't attach that file. Check your connection and try again.");
      } finally {
        setUploading(false);
      }
    };
    input.click();
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments(prev => prev.filter(a => a.id !== id));
  }

  // A failed send keeps the draft and attachments for a retry; only a landed
  // one clears them.
  function landed() {
    setDraft("");
    setPendingAttachments([]);
  }

  const onSend = async () => {
    const body = draft.trim();
    if (!body && pendingAttachments.length === 0) return;
    setSending(true);
    const res = await runAction(toast, () => createReply({
      itemShortId,
      body,
      internal: isNote,
      attachmentIds: pendingAttachments.map(a => a.id),
    }));
    setSending(false);
    if (!res) return;
    landed();
    toast.show({ message: isNote ? "Note added. Only your team can see it." : replySentMessage(res.emailed, first) });
    onSent?.();
  };

  // Reply and close in one go: the customer gets one email (the outcome, with
  // this reply in it). For Won't ship the reply is the reason, so it needs text.
  const onSendAndClose = async (closeAs: "shipped" | "declined") => {
    const body = draft.trim();
    if (closeAs === "shipped") {
      const emails = notifyPlan.status.willEmail || notifyPlan.replies.willEmail;
      const ok = await confirm({
        title: "Send and mark Shipped?",
        body: emails
          ? `${first} gets one email with your reply, and this is marked Shipped.`
          : noEmailNote(notifyPlan.status, "status", first, source),
        confirmLabel: "Send and mark Shipped",
      });
      if (!ok) return;
    }
    // This status wins over one still waiting out its undo window.
    cancelWaitingMove(itemShortId);
    setSending(true);
    const res = await runAction(toast, () => replyAndSetStatus({
      itemShortId,
      body,
      status: closeAs,
      attachmentIds: pendingAttachments.map(a => a.id),
    }));
    setSending(false);
    if (!res) return;
    landed();
    toast.show({ message: replySentMessage(res.emailed, first, closeAs) });
    onSent?.(closeAs);
  };

  // AI reply draft — fills the composer; the vendor edits + sends.
  const onDraft = async () => {
    setDrafting(true);
    const res = await runAction(toast, () => draftReplyAction(itemShortId));
    setDrafting(false);
    if (res) setDraft(res.draft);
  };

  const busy = sending || drafting;
  const empty = !draft.trim() && pendingAttachments.length === 0;
  const sendDisabled = busy || empty || (!canWrite && !isNote);
  const offerClose = !isNote && canWrite && !CLOSED_STATUSES.has(status);
  const sendLabel = isNote ? "Add note" : notifyPlan.replies.willEmail ? `Send to ${first}` : "Send reply";

  return (
    <div className={`${framed ? "card-foot" : "reply-composer-bare"} col gap-3`} style={{ alignItems: "stretch" }}>
      <div className="row gap-3 center" style={{ flexWrap: "wrap" }}>
        <div className="seg" role="tablist" aria-label="Who sees this message">
          <button type="button" role="tab" aria-selected={!isNote} onClick={() => setMode("reply")} disabled={sending}>
            Reply
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isNote}
            onClick={() => setMode("note")}
            disabled={sending}
            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
          >
            <Ic.lock style={{ width: 10, height: 10 }} />
            Internal note
          </button>
        </div>
        <span id={noteId} className="text-xs muted" style={{ flex: "1 1 220px", lineHeight: 1.45 }}>
          {isNote
            ? "Only your team can see notes."
            : !canWrite
              ? "Viewers can only add internal notes."
              : replyNote(notifyPlan.replies, first, accountName, source)}
        </span>
      </div>
      <div style={{ position: "relative" }}>
        <textarea
          ref={taRef}
          className="input"
          rows={3}
          placeholder={isNote ? "Write an internal note. Type @ to mention a teammate." : `Write a reply to ${first}.`}
          value={draft}
          onChange={onDraftInput}
          onKeyDown={onComposerKeyDown}
          onBlur={() => setTimeout(() => setMention(null), 120)}
          disabled={busy}
          autoFocus={autoFocus}
          aria-label={isNote ? "Internal note" : `Reply to ${first}`}
          aria-describedby={noteId}
          // Notes sit on the darker paper tone, so the mode reads at a glance.
          style={isNote ? { background: "var(--surface-2)" } : undefined}
        />
        {mention && mentionMatches.length > 0 && (
          <div className="mention-menu">
            {mentionMatches.map((t, i) => (
              <button
                key={t.id}
                type="button"
                className={`mention-opt${i === mentionIdx ? " active" : ""}`}
                onMouseDown={e => { e.preventDefault(); pickMention(t); }}
                onMouseEnter={() => setMentionIdx(i)}
              >
                <Avatar size="sm" kind="ink">{t.initials}</Avatar>
                <span className="truncate">{t.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {pendingAttachments.length > 0 && (
        <div className="row gap-2" style={{ flexWrap: "wrap" }}>
          {pendingAttachments.map(a => (
            <span key={a.id} className="row gap-2 center" style={{
              border: "var(--border)",
              borderRadius: "var(--r-sm)",
              padding: "4px 6px 4px 10px",
              background: "var(--surface)",
              fontSize: "var(--fs-xs)",
            }}>
              <Ic.attach style={{ width: 11, height: 11, opacity: 0.6 }} />
              <span className="truncate" style={{ maxWidth: 220 }}>{a.filename}</span>
              <span className="text-2xs muted mono">{humanBytes(a.sizeBytes)}</span>
              <button
                onClick={() => removePendingAttachment(a.id)}
                style={{ background: "none", border: 0, cursor: "pointer", padding: 2, color: "var(--mute-2)" }}
                aria-label={`Remove ${a.filename}`}
              >
                <Ic.x style={{ width: 11, height: 11 }} />
              </button>
            </span>
          ))}
        </div>
      )}
      {uploadError && <span className="text-xs" style={{ color: "var(--err-text)" }}>{uploadError}</span>}
      <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
        <Btn
          variant="ghost"
          iconOnly
          icon={<Ic.attach style={{ width: 13, height: 13 }} />}
          onClick={pickAndUpload}
          disabled={busy || uploading}
          aria-label="Attach a file"
        />
        {aiReplyAvailable && !isNote && canWrite && (
          <Btn
            sm
            variant="ghost"
            icon={<Ic.sparkle style={{ width: 12, height: 12 }} />}
            onClick={onDraft}
            disabled={busy}
          >
            {drafting ? "Drafting…" : "AI draft"}
          </Btn>
        )}
        {uploading && <span className="text-xs muted">Uploading…</span>}
        <div style={{ flex: 1 }} />
        <Btn sm onClick={() => { setDraft(""); setPendingAttachments([]); }} disabled={busy || (!draft && pendingAttachments.length === 0)}>Clear</Btn>
        {/* Reply-and-close sits beside Send like "Close with comment"; Shipped
            (which asks first) is the one next to it. */}
        {offerClose && (["declined", "shipped"] as const).map(s => (
          <Btn
            key={s}
            sm
            variant="ghost"
            icon={<StatusDot status={s} />}
            onClick={() => onSendAndClose(s)}
            disabled={sendDisabled || (s === "declined" && !draft.trim())}
            title={s === "declined" ? "Your reply is the reason" : undefined}
          >
            Send and mark {statusLabel(s)}
          </Btn>
        ))}
        <Btn
          sm
          variant="primary"
          icon={isNote ? <Ic.lock style={{ width: 12, height: 12 }} /> : <Ic.send style={{ width: 12, height: 12 }} />}
          onClick={onSend}
          disabled={sendDisabled}
        >
          {sending ? (isNote ? "Adding…" : "Sending…") : sendLabel}
        </Btn>
      </div>
    </div>
  );
}
