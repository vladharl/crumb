"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Avatar, Btn, Ic, Pill } from "@crumb/ui";
import { createReply, draftReplyAction } from "@/app/(app)/thread/[shortId]/actions";

// The reply composer's tab. The thread also has a "trail" view; on it the
// composer still posts a customer-facing reply, so anything that isn't
// "internal" is treated as customer-facing (matches the prior thread logic).
export type ComposerTab = "customer" | "internal" | "trail";

export type ComposerAttachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

export type ComposerTeammate = { id: string; name: string; initials: string };

function humanBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The customer/internal reply composer — extracted from the thread so the
 * inbox's reply-in-place drawer and the full thread page share one composer
 * (same @-mention autocomplete, attachments, AI draft, and send semantics).
 * Owns its own draft + send state; the parent supplies the active tab and is
 * told when a reply lands (onSent) so it can refresh / append / collapse.
 *
 * Draft persistence (defaultDraft + onDraftChange) lets the inbox keep an
 * unsent draft alive across a collapse without keeping the drawer mounted.
 */
export function ReplyComposer({
  itemShortId,
  tab,
  submitterName,
  accountName,
  teammates,
  aiReplyAvailable,
  canWrite,
  onSent,
  autoFocus = false,
  defaultDraft = "",
  onDraftChange,
  framed = true,
}: {
  itemShortId: string;
  tab: ComposerTab;
  submitterName: string;
  accountName: string;
  teammates: ComposerTeammate[];
  aiReplyAvailable: boolean;
  canWrite: boolean;
  onSent?: () => void;
  autoFocus?: boolean;
  defaultDraft?: string;
  onDraftChange?: (value: string) => void;
  // `framed` (default) gives the thread's card-foot treatment; the inbox drawer
  // passes false for a borderless inset that the drawer's own padding frames.
  framed?: boolean;
}) {
  const isInternal = tab === "internal";
  const [draft, setDraftState] = useState(defaultDraft);
  const [pending, startTransition] = useTransition();
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<ComposerAttachment[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

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

  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return teammates.filter(t => t.name.toLowerCase().startsWith(q)).slice(0, 6);
  }, [mention, teammates]);

  // Detect an in-progress "@query" at the caret: an @ at line/word start, where
  // the text after it is a prefix of at least one teammate name.
  function detectMention(value: string, caret: number) {
    if (!isInternal) { setMention(null); return; }
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

  // Auto-clear the "Sent" confirmation after a moment so it doesn't linger past
  // the next interaction.
  useEffect(() => {
    if (!sentAt) return;
    const t = setTimeout(() => setSentAt(null), 2200);
    return () => clearTimeout(t);
  }, [sentAt]);

  const onSend = () => {
    const body = draft.trim();
    if (!body && pendingAttachments.length === 0) return;
    const attachmentIds = pendingAttachments.map(a => a.id);
    startTransition(async () => {
      const res = await createReply({
        itemShortId,
        body,
        internal: isInternal,
        attachmentIds,
      });
      if (res.ok) {
        setDraft("");
        setPendingAttachments([]);
        setSentAt(Date.now());
        onSent?.();
      }
    });
  };

  // AI reply draft — fills the composer; the vendor edits + sends.
  const onDraft = () => {
    setDraftError(null);
    setDrafting(true);
    startTransition(async () => {
      const res = await draftReplyAction(itemShortId);
      setDrafting(false);
      if (res.ok) setDraft(res.draft);
      else setDraftError(res.error === "ai_cap_reached" ? "You've reached this month's AI usage limit. It resets on the 1st." : "Couldn't draft a reply. Try again.");
    });
  };

  const sendDisabled = pending || (!draft.trim() && pendingAttachments.length === 0) || (!canWrite && !isInternal);

  return (
    <div className={`${framed ? "card-foot" : "reply-composer-bare"} col gap-3`} style={{ alignItems: "stretch" }}>
      <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
        <Pill ring ringFill={!isInternal}>
          {isInternal ? "Internal only" : `Replying to ${submitterName}. ${accountName} can see this`}
        </Pill>
        {!canWrite && !isInternal && (
          <span className="text-xs muted">Viewers can only post internal notes. Switch to the Internal tab.</span>
        )}
        {sentAt && (
          <Pill solid>
            <Ic.check style={{ width: 10, height: 10 }} />
            Sent
          </Pill>
        )}
      </div>
      <div style={{ position: "relative" }}>
        <textarea
          ref={taRef}
          className="input"
          rows={3}
          placeholder={isInternal ? "Internal note. Type @ to mention a teammate. (Customers can't see this.)" : "Write a reply."}
          value={draft}
          onChange={onDraftInput}
          onKeyDown={onComposerKeyDown}
          onBlur={() => setTimeout(() => setMention(null), 120)}
          disabled={pending}
          autoFocus={autoFocus}
          aria-label={isInternal ? "Internal note" : "Reply to customer"}
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
      {draftError && <span className="text-xs" style={{ color: "var(--err-text)" }}>{draftError}</span>}
      <div className="row gap-2 center">
        <Btn
          variant="ghost"
          iconOnly
          icon={<Ic.attach style={{ width: 13, height: 13 }} />}
          onClick={pickAndUpload}
          disabled={pending || uploading}
          aria-label="Attach a file"
        />
        {aiReplyAvailable && !isInternal && canWrite && (
          <Btn
            sm
            variant="ghost"
            icon={<Ic.sparkle style={{ width: 12, height: 12 }} />}
            onClick={onDraft}
            disabled={pending}
          >
            {drafting ? "Drafting…" : "AI draft"}
          </Btn>
        )}
        {uploading && <span className="text-xs muted">Uploading…</span>}
        <div style={{ flex: 1 }} />
        <Btn sm onClick={() => { setDraft(""); setPendingAttachments([]); }} disabled={pending || (!draft && pendingAttachments.length === 0)}>Clear</Btn>
        <Btn sm variant="primary" icon={<Ic.send style={{ width: 12, height: 12 }} />} onClick={onSend} disabled={sendDisabled}>
          {pending ? "Sending…" : "Send"}
        </Btn>
      </div>
    </div>
  );
}
