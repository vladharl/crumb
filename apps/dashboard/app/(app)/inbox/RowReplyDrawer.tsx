"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar, Btn, Ic, Pill, StatusDot, StatusPill, TrailDots, trailProgress } from "@crumb/ui";
import type { Status } from "@crumb/ui";
import { LOOP_CLOSED_STATUSES } from "@/lib/loop";
import { useToast } from "@/components/toast";
import { ReplyComposer } from "@/components/ReplyComposer";
import { updateStatus, translateItem } from "@/app/(app)/thread/[shortId]/actions";
import { getReplyContext, type ReplyContext, type ReplyDrawerMessage } from "./reply-actions";
import type { InboxRow } from "./InboxTable";

function formatArr(cents: number): string {
  if (cents <= 0) return "—";
  if (cents >= 100_000_000) return `$${(cents / 100_000_000).toFixed(1)}M ARR`;
  return `$${Math.round(cents / 100_000)}k ARR`;
}

function relAge(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return "now";
  const units: Array<[string, number]> = [
    ["w", 6.048e8], ["d", 8.64e7], ["h", 3.6e6], ["m", 6e4],
  ];
  for (const [u, ms] of units) if (d >= ms) return `${Math.floor(d / ms)}${u}`;
  return "now";
}

function humanBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

const STATUS_LABEL: Partial<Record<string, string>> = {
  shipped: "Shipped", declined: "Won’t ship", duplicate: "Duplicate",
};

function ConvoMessage({ m, accountName, i }: { m: ReplyDrawerMessage; accountName: string; i: number }) {
  return (
    <div className="rd-msg" style={{ "--i": i } as React.CSSProperties}>
      <Avatar size="sm" kind={m.kind === "vendor" ? "ink" : ""}>{m.authorInitials}</Avatar>
      <div className="col gap-1 grow" style={{ minWidth: 0 }}>
        <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
          <span className="text-sm fw-med">{m.authorName}</span>
          {m.kind === "vendor" ? <Pill solid>Vendor</Pill> : m.kind === "customer" ? <Pill>{accountName}</Pill> : <Pill>System</Pill>}
          <span className="text-2xs muted mono" style={{ marginLeft: "auto" }}>{relAge(m.createdAt)}</span>
        </div>
        {m.body && <p className="rd-body text-sm">{m.body}</p>}
        {m.attachments.length > 0 && (
          <div className="row gap-2" style={{ flexWrap: "wrap", marginTop: 2 }}>
            {m.attachments.map(a => (
              <a key={a.id} href={`/api/v1/uploads/${a.id}`} target="_blank" rel="noreferrer" className="rd-att">
                <Ic.attach style={{ width: 11, height: 11, opacity: 0.6 }} />
                <span className="truncate" style={{ maxWidth: 180 }}>{a.filename}</span>
                <span className="text-2xs muted mono">{humanBytes(a.sizeBytes)}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Reply-in-place: an inline drawer under an inbox row to read the recent
 * conversation, answer the customer, and close the loop without leaving the
 * queue. Header/status/trail seed instantly from the row; the conversation,
 * ARR and composer context stream in via getReplyContext. The full thread is
 * always one click away.
 */
export function RowReplyDrawer({
  row, canWrite, onCollapse, draft, onDraftChange,
}: {
  row: InboxRow;
  canWrite: boolean;
  onCollapse: () => void;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [ctx, setCtx] = useState<ReplyContext | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [tab, setTab] = useState<"customer" | "internal">("customer");
  const [closePending, startClose] = useTransition();
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const [translating, startTranslate] = useTransition();
  const alive = useRef(true);

  async function load() {
    const res = await getReplyContext(row.shortId);
    if (!alive.current) return;
    if (res.ok) { setCtx(res.context); setLoadError(false); }
    else setLoadError(true);
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
    // Reload when the row identity changes; row mutations refresh via the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.shortId]);

  const closed = LOOP_CLOSED_STATUSES.has(row.status);
  const progress = trailProgress({ status: row.status, vendorReplied: row.vendorReplied });
  const messages = tab === "customer" ? ctx?.customerMessages : ctx?.internalMessages;
  const atCap = (messages?.length ?? 0) >= 5;
  const foreign = !!ctx?.detectedLang && ctx.detectedLang !== "en";

  function onSent() {
    // Reply landed: refresh the inbox so the row re-buckets (Your turn →
    // Waiting) and re-pull the conversation so the new message appears.
    onDraftChange("");
    router.refresh();
    void load();
    toast.show({ message: `Reply sent to ${row.submitterName}.` });
  }

  function markShipped() {
    startClose(async () => {
      const res = await updateStatus({ itemShortId: row.shortId, status: "shipped" });
      if (res.ok) {
        router.refresh();
        toast.show({ message: `Marked Shipped · ${row.accountName} notified.` });
        onCollapse();
      } else {
        toast.show({ message: "Couldn't update status. Nothing changed.", tone: "error" });
      }
    });
  }

  function submitWontShip() {
    const r = reason.trim();
    if (!r) { setReasonError("A reason is required so the customer sees the why."); return; }
    startClose(async () => {
      const res = await updateStatus({ itemShortId: row.shortId, status: "declined", reason: r });
      if (res.ok) {
        router.refresh();
        toast.show({ message: `Marked Won’t ship · ${row.accountName} notified.` });
        onCollapse();
      } else {
        setReasonError(res.error === "reason_required" ? "A reason is required." : "Couldn't update status. Nothing changed.");
      }
    });
  }

  function onTranslate() {
    startTranslate(async () => {
      const res = await translateItem(row.shortId);
      if (res.ok) { setShowTranslation(true); void load(); }
      else toast.show({ message: "Couldn't translate this feedback.", tone: "error" });
    });
  }

  // Esc anywhere in the drawer collapses it (the draft is preserved by the
  // parent), unless a menu inside is handling its own Escape.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); onCollapse(); }
  }

  return (
    <div className="rd" role="region" aria-label={`Reply to ${row.submitterName}`} onKeyDown={onKeyDown}>
      <div className="rd-head">
        <div className="row gap-2 center" style={{ flexWrap: "wrap", minWidth: 0 }}>
          <Avatar size="sm" kind="ink">{row.accountName.slice(0, 1).toUpperCase()}</Avatar>
          <span className="text-sm fw-med truncate" style={{ maxWidth: 200 }}>{row.accountName}</span>
          <span className="text-xs muted">·</span>
          <span className="text-xs muted truncate" style={{ maxWidth: 160 }}>{row.submitterName}</span>
          {/* ARR seeds instantly from the row — the revenue unit is visible the
              moment the drawer opens, before the conversation streams in. */}
          {row.arrAtStakeCents > 0 && <Pill ring>{formatArr(row.arrAtStakeCents)}</Pill>}
          <StatusPill status={row.status as Status} />
          <TrailDots progress={progress} size={13} />
        </div>
        <div className="row gap-1 center" style={{ flexShrink: 0 }}>
          <Link href={`/thread/${row.shortId}`} className="rd-openthread">
            Open thread <Ic.chevR style={{ width: 11, height: 11 }} />
          </Link>
          <button type="button" className="rd-close" aria-label="Collapse reply" onClick={onCollapse}>
            <Ic.x style={{ width: 14, height: 14 }} />
          </button>
        </div>
      </div>

      {foreign && (
        <div className="rd-translate">
          <Ic.globe style={{ width: 13, height: 13, color: "var(--mute)", flexShrink: 0 }} />
          <span className="text-xs">This feedback is in <strong style={{ fontWeight: 600 }}>{ctx!.detectedLang!.toUpperCase()}</strong>.</span>
          {ctx!.titleTranslated ? (
            <button type="button" className="rd-link" onClick={() => setShowTranslation(s => !s)}>
              {showTranslation ? "Hide translation" : "Show translation"}
            </button>
          ) : ctx!.aiReplyAvailable && canWrite ? (
            <button type="button" className="rd-link" onClick={onTranslate} disabled={translating}>
              {translating ? "Translating…" : "Translate to English"}
            </button>
          ) : null}
        </div>
      )}

      {showTranslation && ctx?.titleTranslated && (
        <div className="rd-translation">
          <span className="text-sm fw-med">{ctx.titleTranslated}</span>
          {ctx.bodyTranslated && <p className="rd-body text-sm" style={{ marginTop: 4 }}>{ctx.bodyTranslated}</p>}
        </div>
      )}

      <div className="seg" role="tablist" aria-label="Conversation" style={{ alignSelf: "flex-start" }}>
        <button role="tab" aria-selected={tab === "customer"} onClick={() => setTab("customer")}>Customer</button>
        <button role="tab" aria-selected={tab === "internal"} onClick={() => setTab("internal")}>Internal</button>
      </div>

      <div className="rd-convo">
        {loadError ? (
          <div className="row gap-2 center" style={{ padding: "4px 0" }}>
            <span className="text-sm" style={{ color: "var(--err-text)" }}>Couldn't load the conversation.</span>
            <button type="button" className="rd-link" onClick={() => void load()}>Retry</button>
          </div>
        ) : !ctx ? (
          <div className="col gap-3" aria-hidden style={{ padding: "2px 0" }}>
            <div className="row gap-3 center"><span className="skel" style={{ width: 24, height: 24, borderRadius: 999 }} /><span className="skel" style={{ width: "55%", height: 12 }} /></div>
            <span className="skel" style={{ width: "92%", height: 12, marginLeft: 36 }} />
            <span className="skel" style={{ width: "78%", height: 12, marginLeft: 36 }} />
          </div>
        ) : messages && messages.length > 0 ? (
          <>
            {messages.map((m, i) => <ConvoMessage key={m.id} m={m} accountName={row.accountName} i={i} />)}
            {atCap && (
              <Link href={`/thread/${row.shortId}`} className="rd-link" style={{ alignSelf: "flex-start" }}>
                Showing the latest 5. Open the thread for the full trail
              </Link>
            )}
          </>
        ) : (
          <p className="text-sm muted" style={{ margin: 0 }}>
            {tab === "internal"
              ? "No internal notes yet. They stay private to your workspace."
              : "No customer messages yet. Your reply starts the trail."}
          </p>
        )}
      </div>

      {ctx && (
        <ReplyComposer
          itemShortId={row.shortId}
          tab={tab}
          submitterName={row.submitterName}
          accountName={row.accountName}
          teammates={ctx.teammates}
          aiReplyAvailable={ctx.aiReplyAvailable}
          canWrite={canWrite}
          onSent={onSent}
          autoFocus
          defaultDraft={draft}
          onDraftChange={onDraftChange}
          framed={false}
        />
      )}

      {canWrite && (
        closed ? (
          <div className="rd-foot rd-foot-closed">
            <Ic.check style={{ width: 13, height: 13, color: "var(--green)" }} />
            <span className="text-xs muted">Loop closed · {STATUS_LABEL[row.status] ?? row.status}. Reopen from the thread.</span>
          </div>
        ) : reasonOpen ? (
          <div className="rd-foot col gap-2" style={{ alignItems: "stretch" }}>
            <span className="eyebrow">Won’t ship: tell {row.submitterName} why</span>
            <textarea
              className="input"
              rows={2}
              autoFocus
              placeholder="e.g. We’re not building this in v2. The maintenance cost is too high for the use case."
              value={reason}
              onChange={e => { setReason(e.target.value); setReasonError(null); }}
              disabled={closePending}
            />
            {reasonError && <span className="text-xs" style={{ color: "var(--err-text)" }}>{reasonError}</span>}
            <div className="row gap-2">
              <Btn sm onClick={() => { setReasonOpen(false); setReason(""); setReasonError(null); }} disabled={closePending}>Cancel</Btn>
              <Btn sm variant="primary" onClick={submitWontShip} disabled={closePending || !reason.trim()}>
                {closePending ? "Saving…" : "Won’t ship & notify"}
              </Btn>
            </div>
          </div>
        ) : (
          <div className="rd-foot row gap-2 center" style={{ flexWrap: "wrap" }}>
            <span className="eyebrow">Close the loop</span>
            <div className="row gap-2 center" style={{ marginLeft: "auto" }}>
              <Btn sm icon={<StatusDot status="shipped" />} onClick={markShipped} disabled={closePending}>Mark shipped</Btn>
              <Btn sm icon={<StatusDot status="declined" />} onClick={() => setReasonOpen(true)} disabled={closePending}>Won’t ship</Btn>
            </div>
          </div>
        )
      )}
    </div>
  );
}
