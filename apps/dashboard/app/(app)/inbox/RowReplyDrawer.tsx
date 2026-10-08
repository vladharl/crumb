"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar, Btn, Ic, Pill, REASON_PLACEHOLDER, StatusDot, StatusPill, TrailDots, trailProgress, statusLabel } from "@crumb/ui";
import type { Status } from "@crumb/ui";
import { LOOP_CLOSED_STATUSES } from "@/lib/loop";
import { formatArr } from "@/lib/priority";
import { useToast } from "@/components/toast";
import { ReplyComposer, useStatusMove, runAction, firstName, statusEmailees, reasonNote } from "@/components/ReplyComposer";
import { translateItem } from "@/app/(app)/thread/[shortId]/actions";
import { getReplyContext, type ReplyContext, type ReplyDrawerMessage } from "./reply-actions";
import type { InboxRow } from "./InboxTable";

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
  const [reasonOpen, setReasonOpen] = useState(false);
  // Kept until the move lands, so an undone Won't ship reopens with its reason.
  const [reason, setReason] = useState("");
  const [showTranslation, setShowTranslation] = useState(false);
  const [translating, startTranslate] = useTransition();
  const alive = useRef(true);
  const first = firstName(row.submitterName);

  async function load() {
    try {
      const res = await getReplyContext(row.shortId);
      if (!alive.current) return;
      if (res.ok) { setCtx(res.context); setLoadError(false); }
      else setLoadError(true);
    } catch {
      if (alive.current) setLoadError(true);
    }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
    // Reload when the row identity changes; row mutations refresh via the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.shortId]);

  // Close-the-loop moves: shown at once; one that emails waits behind an Undo
  // toast, and the drawer collapses once the move lands (useStatusMove). Until
  // the context loads the plan is unknown, so the buttons wait for it.
  const statusMove = useStatusMove({
    itemShortId: row.shortId,
    status: row.status,
    first,
    source: row.source,
    plan: ctx?.notifyPlan.status ?? { willEmail: true },
    mergedReach: ctx?.mergedReach ?? 0,
    onMoved: () => {
      setReason("");
      if (alive.current) onCollapse();
    },
  });
  const shown = statusMove.shown;
  const closed = LOOP_CLOSED_STATUSES.has(shown);
  const progress = trailProgress({ status: shown, vendorReplied: row.vendorReplied });
  const messages = tab === "customer" ? ctx?.customerMessages : ctx?.internalMessages;
  const atCap = (messages?.length ?? 0) >= 5;
  const foreign = !!ctx?.detectedLang && ctx.detectedLang !== "en";
  const closeDisabled = !ctx || statusMove.saving;
  // Both outcomes email the submitter when their plan allows it, and the
  // customers whose requests were merged into this one.
  const emailees = ctx && (ctx.notifyPlan.status.willEmail || ctx.mergedReach > 0)
    ? statusEmailees(first, ctx.notifyPlan.status.willEmail, ctx.mergedReach)
    : null;

  function onSent(closedAs?: "shipped" | "declined") {
    // Something landed (the composer toasts what): refresh the inbox so the
    // row re-buckets (Your turn → Waiting / Closed), then re-pull the
    // conversation, or collapse when the reply also closed the loop.
    onDraftChange("");
    router.refresh();
    if (closedAs) onCollapse();
    else void load();
  }

  function submitWontShip() {
    const r = reason.trim();
    if (!r) return;
    setReasonOpen(false);
    void statusMove.move("declined", r);
  }

  function onTranslate() {
    startTranslate(async () => {
      if (await runAction(toast, () => translateItem(row.shortId))) { setShowTranslation(true); void load(); }
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
          {row.arrAtStakeCents > 0 && <Pill ring>{formatArr(row.arrAtStakeCents, " ARR at stake")}</Pill>}
          <StatusPill status={shown as Status} />
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
          <span className="text-xs">This request is in <strong style={{ fontWeight: 600 }}>{ctx!.detectedLang!.toUpperCase()}</strong>.</span>
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

      {/* Who a message reaches is the composer's Reply / Internal note
          switch; switching the tabs above flips it to match. */}
      {ctx && (
        <ReplyComposer
          itemShortId={row.shortId}
          status={shown}
          submitterName={row.submitterName}
          accountName={row.accountName}
          source={row.source}
          notifyPlan={ctx.notifyPlan}
          mergedReach={ctx.mergedReach}
          teammates={ctx.teammates}
          aiReplyAvailable={ctx.aiReplyAvailable}
          canWrite={canWrite}
          onSent={onSent}
          autoFocus
          defaultDraft={draft}
          onDraftChange={onDraftChange}
          framed={false}
          tabMode={tab === "internal" ? "note" : "reply"}
        />
      )}

      {canWrite && (
        closed ? (
          <div className="rd-foot rd-foot-closed">
            <Ic.check style={{ width: 13, height: 13, color: "var(--green)" }} />
            <span className="text-xs muted">Closed as {statusLabel(shown)}. Reopen from the thread.</span>
          </div>
        ) : reasonOpen ? (
          <div className="rd-foot col gap-2" style={{ alignItems: "stretch" }}>
            <span className="eyebrow">Won’t ship: say why</span>
            <textarea
              className="input"
              rows={2}
              autoFocus
              aria-label="Reason for Won’t ship"
              placeholder={REASON_PLACEHOLDER.declined}
              value={reason}
              onChange={e => setReason(e.target.value)}
              disabled={closeDisabled}
            />
            {ctx && reasonNote(first, ctx.notifyPlan.status.willEmail, ctx.mergedReach) && (
              <span className="text-xs muted">{reasonNote(first, ctx.notifyPlan.status.willEmail, ctx.mergedReach)}</span>
            )}
            <div className="row gap-2">
              <Btn sm onClick={() => { setReasonOpen(false); setReason(""); }} disabled={statusMove.saving}>Cancel</Btn>
              <Btn sm variant="primary" onClick={submitWontShip} disabled={closeDisabled || !reason.trim()}>
                Mark Won’t ship
              </Btn>
            </div>
          </div>
        ) : (
          <div className="rd-foot row gap-2 center" style={{ flexWrap: "wrap" }}>
            <span className="eyebrow">Close the loop</span>
            {emailees && <span className="text-2xs muted">emails {emailees}</span>}
            <div className="row gap-2 center" style={{ marginLeft: "auto" }}>
              <Btn sm icon={<StatusDot status="shipped" />} onClick={() => void statusMove.move("shipped")} disabled={closeDisabled}>Mark shipped</Btn>
              <Btn sm icon={<StatusDot status="declined" />} onClick={() => setReasonOpen(true)} disabled={closeDisabled}>Won’t ship</Btn>
            </div>
          </div>
        )
      )}
    </div>
  );
}
