"use client";

import { useMemo, useState, useTransition, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Avatar, Btn, Card, CardHead, Dropdown, Ic, PageHead, Pill, StatusDot, StatusPill, TrailDots, trailProgress,
  CLOSED_STATUSES, REASON_PLACEHOLDER, REASON_REQUIRED, VENDOR_STATUS_OPTIONS, statusLabel,
} from "@crumb/ui";
import type { Status, VendorStatus } from "@crumb/ui";
import { translateItem, assignItem, updateType } from "./actions";
import { useToast } from "@/components/toast";
import {
  ReplyComposer, useStatusMove, runAction, firstName, sourceLabel, noEmailNote, statusWillEmail, type ItemNotifyPlan,
} from "@/components/ReplyComposer";
import { InitiativePanel, type ThreadInitiativeOption } from "./InitiativePanel";
import { ThreadSuggestionCard, type ThreadSuggestion } from "./ThreadSuggestionCard";
import { ExternalTicketTile } from "./ExternalTicketTile";
import { ReplaySessionCard, type ReplayCardData } from "./ReplaySessionCard";
import { UsageBreadcrumbCard, type UsageBreadcrumbEntry } from "./UsageBreadcrumbCard";
import { MergePanel, type ThreadMergeData } from "./MergePanel";

function formatArr(cents: number): string {
  if (cents === 0) return "—";
  if (cents >= 100_000_000) return `$${(cents / 100_000_000).toFixed(1)}M ARR`;
  return `$${Math.round(cents / 100_000)}k ARR`;
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Wraps `@Teammate Name` occurrences in a styled chip. Longest names first so
// "@Lina Rivers" wins over "@Lina". Names not matching a teammate stay plain.
function MentionText({ body, names }: { body: string; names: string[] }) {
  if (names.length === 0 || !body.includes("@")) return <>{body}</>;
  const sorted = [...names].sort((a, b) => b.length - a.length).map(reEscape).filter(Boolean);
  if (sorted.length === 0) return <>{body}</>;
  const re = new RegExp(`@(?:${sorted.join("|")})`, "gi");
  const out: React.ReactNode[] = [];
  let last = 0, key = 0, m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m.index > last) out.push(body.slice(last, m.index));
    out.push(<span key={key++} className="mention">{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return <>{out}</>;
}

function humanBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentPill({ a }: { a: ThreadAttachment }) {
  return (
    <a
      href={`/api/v1/uploads/${a.id}`}
      target="_blank"
      rel="noreferrer"
      className="row gap-2 center"
      style={{
        textDecoration: "none",
        color: "var(--ink)",
        border: "var(--border)",
        borderRadius: "var(--r-sm)",
        padding: "6px 10px",
        background: "var(--surface)",
        fontSize: "var(--fs-xs)",
        maxWidth: "100%",
      }}
    >
      <Ic.attach style={{ width: 12, height: 12, opacity: 0.6 }} />
      <span className="truncate" style={{ minWidth: 0 }}>{a.filename}</span>
      <span className="text-2xs muted mono">{humanBytes(a.sizeBytes)}</span>
    </a>
  );
}

export type ThreadAttachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

export type ThreadMessage = {
  id: string;
  kind: "vendor" | "customer" | "system";
  authorName: string;
  authorInitials: string;
  body: string;
  internal: boolean;
  createdAt: string;
  attachments: ThreadAttachment[];
};

export type ThreadStatusEvent = {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  byName: string | null;
  at: string;
};

// A customer-notification ledger entry: the moment the customer heard back.
export type ThreadNotice = {
  id: string;
  kind: "reply" | "status";
  toStatus: string | null;
  at: string;
};

export type ThreadData = {
  item: {
    shortId: string;
    title: string;
    body: string;
    type: string;
    status: string;
    externalProvider: "linear" | "jira" | "github" | null;
    externalTicketId: string | null;
    externalTicketUrl: string | null;
    externalStatus: string | null;
    externalSyncedAt: string | null;
    createdAt: string;
    detectedLang: string | null;
    titleTranslated: string | null;
    bodyTranslated: string | null;
    // Where it came in (null for native items) and an http(s) link back to it.
    source: string | null;
    sourceUrl: string | null;
  };
  notifyPlan: ItemNotifyPlan;
  account: { id: string; name: string; arrCents: number };
  submitter: { name: string; initials: string };
  assignee: { id: string; initials: string; name: string } | null;
  messages: ThreadMessage[];
  events: ThreadStatusEvent[];
  notices: ThreadNotice[];
  teammates: { id: string; name: string; initials: string }[];
  initiative: ThreadInitiativeOption | null;
  initiativeOptions: ThreadInitiativeOption[];
  canManageInitiatives: boolean;
  suggestion: ThreadSuggestion | null;
  workspaceIntegrations: {
    linearInstalledAt: string | null;
    jiraInstalledAt: string | null;
    githubInstalledAt: string | null;
  };
  aiTicketAvailable: boolean;
  aiReplyAvailable: boolean;
  replay: ReplayCardData | null;
  usageBreadcrumb: UsageBreadcrumbEntry[] | null;
  merge: ThreadMergeData;
};

function relAge(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  const units: Array<[string, number]> = [
    ["w", 1000 * 60 * 60 * 24 * 7],
    ["d", 1000 * 60 * 60 * 24],
    ["h", 1000 * 60 * 60],
    ["m", 1000 * 60],
  ];
  if (d < 60_000) return "now";
  for (const [u, ms] of units) if (d >= ms) return `${Math.floor(d / ms)}${u}`;
  return "now";
}

type TrailEntry =
  | { kind: "message"; at: string; msg: ThreadMessage }
  | { kind: "event";   at: string; event: ThreadStatusEvent }
  | { kind: "notice";  at: string; notice: ThreadNotice };

export function ThreadView({ data, canWrite }: { data: ThreadData; canWrite: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const { item, notifyPlan, account, submitter, assignee, messages, events, notices, teammates, initiative, initiativeOptions, canManageInitiatives, suggestion, workspaceIntegrations, aiTicketAvailable, aiReplyAvailable, replay, usageBreadcrumb, merge } = data;
  const teammateNames = useMemo(() => teammates.map(t => t.name), [teammates]);
  const first = firstName(submitter.name);

  const customerMsgs = messages.filter(m => !m.internal);
  const internalMsgs = messages.filter(m => m.internal);

  const trail: TrailEntry[] = useMemo(() => {
    const all: TrailEntry[] = [
      ...messages.filter(m => !m.internal).map(msg => ({ kind: "message" as const, at: msg.createdAt, msg })),
      ...events.map(event => ({ kind: "event" as const, at: event.at, event })),
      ...notices.map(notice => ({ kind: "notice" as const, at: notice.at, notice })),
    ];
    all.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    return all;
  }, [messages, events, notices]);

  const [tab, setTab] = useState<"customer" | "internal" | "trail">("customer");
  const [pending, startTransition] = useTransition();
  const [reasonFor, setReasonFor] = useState<VendorStatus | null>(null);
  // Kept until the move lands, so an undone one reopens with its reason.
  const [reasonText, setReasonText] = useState("");
  const [showTranslation, setShowTranslation] = useState(false);

  // Status moves show at once; one that emails the customer waits behind an
  // Undo toast first (see useStatusMove).
  const statusMove = useStatusMove({
    itemShortId: item.shortId,
    status: item.status,
    first,
    source: item.source,
    plan: notifyPlan.status,
    onMoved: () => setReasonText(""),
  });
  const shown = statusMove.shown;

  const progress = useMemo(() => trailProgress({
    status: shown,
    vendorReplied: messages.some(m => m.kind === "vendor" && !m.internal),
  }), [shown, messages]);

  const onTranslate = () => {
    startTransition(async () => {
      if (await runAction(toast, () => translateItem(item.shortId))) { setShowTranslation(true); router.refresh(); }
    });
  };

  const submitReason = () => {
    const reason = reasonText.trim();
    if (!reasonFor || !reason) return;
    setReasonFor(null);
    void statusMove.move(reasonFor, reason);
  };

  // Details-card property edits (assignee / type) — single-item, in place.
  function onAssign(value: string) {
    startTransition(async () => {
      if (await runAction(toast, () => assignItem(item.shortId, value === "__unassign" ? null : value))) router.refresh();
    });
  }

  function onType(value: string) {
    startTransition(async () => {
      if (await runAction(toast, () => updateType(item.shortId, value))) router.refresh();
    });
  }

  const visible = tab === "customer" ? customerMsgs : internalMsgs;

  return (
    <>
      <PageHead
        crumb={<><Link href="/inbox" style={{ color: "inherit" }}>Inbox</Link><Ic.chevR style={{ width: 10, height: 10 }} /><span className="mono">{item.shortId}</span></>}
        title={item.title}
        // Shared elements for the inbox→thread View Transition: the row's title
        // lifts into this heading and its loop dot blooms into the full trail.
        titleStyle={{ viewTransitionName: "vt-thread-title" }}
        actions={
          <>
            <span style={{ viewTransitionName: "vt-thread-trail", display: "inline-flex", lineHeight: 0 }}>
              <TrailDots progress={progress} size={14} />
            </span>
            <StatusPill status={shown as Status} />
            {item.externalTicketUrl && (
              <a href={item.externalTicketUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <Btn icon={<Ic.link style={{ width: 12, height: 12 }} />}>{item.externalTicketId}</Btn>
              </a>
            )}
          </>
        }
      />

      <div className="seg" style={{ alignSelf: "flex-start" }}>
        <button aria-selected={tab === "customer"} onClick={() => setTab("customer")}>Customer · {customerMsgs.length}</button>
        <button aria-selected={tab === "internal"} onClick={() => setTab("internal")}>Internal · {internalMsgs.length}</button>
        <button aria-selected={tab === "trail"}    onClick={() => setTab("trail")}>Trail · {trail.length}</button>
      </div>

      {item.detectedLang && item.detectedLang !== "en" && (
        <div className="row gap-3 center" style={{
          padding: "8px 12px", border: "var(--border)", borderRadius: "var(--r-sm)",
          background: "var(--surface-2)", flexWrap: "wrap",
        }}>
          <Ic.globe style={{ width: 14, height: 14, color: "var(--mute)", flexShrink: 0 }} />
          <span className="text-sm">This feedback is in <strong style={{ fontWeight: 500 }}>{item.detectedLang.toUpperCase()}</strong>.</span>
          {item.titleTranslated ? (
            <Btn sm variant="ghost" onClick={() => setShowTranslation(s => !s)}>
              {showTranslation ? "Hide translation" : "Show translation"}
            </Btn>
          ) : aiReplyAvailable && canWrite ? (
            <Btn sm onClick={onTranslate} disabled={pending}>{pending ? "Translating…" : "Translate to English"}</Btn>
          ) : null}
        </div>
      )}

      {showTranslation && item.titleTranslated && (
        <Card>
          <CardHead title="Translation" after={<Pill ring>auto</Pill>} />
          <div className="card-body col gap-2">
            <span className="serif text-lg">{item.titleTranslated}</span>
            {item.bodyTranslated && <p className="text-md" style={{ margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{item.bodyTranslated}</p>}
          </div>
        </Card>
      )}

      <div className="cols-2-1" style={{ alignItems: "start" }}>
        <Card>
          <div className="card-body col gap-5">
            {tab === "trail" ? (
              trail.length === 0 ? (
                <p className="text-sm muted" style={{ margin: 0 }}>
                  Nothing here yet. Replies and status changes will land in this trail.
                </p>
              ) : (
                // The loop made spatial: an ember spine draws itself top→bottom
                // (oldest → newest) and each crumb lands as the line reaches it,
                // so the trail is *seen* being followed. The closing crumb blooms
                // once at the end — "the customer heard back". All reveal-only:
                // the resting state is fully visible, and reduced motion shows
                // the whole trail static (see globals.css .trail-timeline).
                <div className="trail-timeline" style={{ "--n": trail.length } as CSSProperties}>
                  <span className="trail-spine" aria-hidden />
                  {/* Notice crumbs come only from the customer_notifications
                      ledger, which records emails a real provider accepted, so
                      "was told" and "loop closed" never show for an email that
                      didn't go out. */}
                  {trail.map((entry, i) => entry.kind === "notice" ? (
                    <div key={`n:${entry.notice.id}`} className="trail-node" style={{ "--i": i } as CSSProperties}>
                      <span className="trail-crumb notice" aria-hidden />
                      <div className="trail-node-body col grow gap-1">
                        <span className="text-sm">
                          <span className="fw-med">{submitter.name}</span>
                          <span className="muted">
                            {entry.notice.kind === "reply"
                              ? " was notified of the reply"
                              : entry.notice.toStatus === "declined"
                                ? " was told it won’t ship"
                                : ` was told it's ${(entry.notice.toStatus ? statusLabel(entry.notice.toStatus) : "updated").toLowerCase()}`}
                          </span>
                          {entry.notice.kind === "status" && CLOSED_STATUSES.has(entry.notice.toStatus ?? "") && (
                            <strong style={{ fontWeight: 500, color: "var(--accent-deep)" }}> · loop closed</strong>
                          )}
                        </span>
                      </div>
                      <span className="trail-node-age text-xs muted mono">{relAge(entry.at)}</span>
                    </div>
                  ) : entry.kind === "event" ? (
                    <div key={`e:${entry.event.id}`} className="trail-node" style={{ "--i": i } as CSSProperties}>
                      <span className="trail-crumb event" aria-hidden />
                      <div className="trail-node-body col grow gap-1">
                        <span className="text-sm">
                          <span className="fw-med">{entry.event.byName ?? "System"}</span>
                          <span className="muted">
                            {entry.event.fromStatus
                              ? ` moved status to `
                              : ` submitted as `}
                          </span>
                          <strong style={{ fontWeight: 500 }}>{statusLabel(entry.event.toStatus)}</strong>
                          {entry.event.fromStatus && (
                            <span className="muted text-xs"> (from {statusLabel(entry.event.fromStatus)})</span>
                          )}
                        </span>
                        {entry.event.reason && (
                          <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.55, fontStyle: "italic" }}>
                            "{entry.event.reason}"
                          </p>
                        )}
                      </div>
                      <span className="trail-node-age text-xs muted mono">{relAge(entry.at)}</span>
                    </div>
                  ) : (
                    <div key={`m:${entry.msg.id}`} className="trail-node" style={{ "--i": i } as CSSProperties}>
                      <span className="trail-crumb message" aria-hidden />
                      <div className="trail-node-body col grow gap-1">
                        <span className="text-sm">
                          <span className="fw-med">{entry.msg.authorName}</span>
                          <span className="muted"> replied</span>
                        </span>
                        <p className="text-sm" style={{ margin: 0, lineHeight: 1.55, color: "var(--text)" }}>
                          {entry.msg.body.length > 160 ? entry.msg.body.slice(0, 159) + "…" : entry.msg.body}
                        </p>
                      </div>
                      <span className="trail-node-age text-xs muted mono">{relAge(entry.at)}</span>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <>
                {visible.length === 0 && (
                  <p className="text-sm muted" style={{ margin: 0 }}>
                    {tab === "internal" ? "No internal notes yet. They stay private to your workspace." : "No customer messages yet."}
                  </p>
                )}

                {visible.map((m, i) => (
                  <div key={m.id}>
                    <div className="row start gap-4">
                      <Avatar kind={m.kind === "vendor" ? "ink" : ""} size="lg">{m.authorInitials}</Avatar>
                      <div className="col gap-2 grow">
                        <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
                          <span className="serif text-lg">{m.authorName}</span>
                          <span className="text-xs muted">·</span>
                          {m.kind === "vendor"
                            ? <Pill solid>Vendor</Pill>
                            : m.kind === "customer"
                              ? <Pill>{account.name}</Pill>
                              : <Pill>System</Pill>}
                          {m.internal && <Pill solid><Ic.lock style={{ width: 10, height: 10 }} />Internal · private to your workspace</Pill>}
                          <span className="text-xs muted mono" style={{ marginLeft: "auto" }}>{relAge(m.createdAt)}</span>
                        </div>
                        {m.internal ? (
                          // The darker paper tone notes are written on in the
                          // composer, so a note reads the same both places.
                          <div style={{
                            background: "var(--surface-2)",
                            border: "var(--border)",
                            borderRadius: "var(--r-sm)",
                            padding: "10px 12px",
                          }}>
                            <p className="text-md" style={{ margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                              <MentionText body={m.body} names={teammateNames} />
                            </p>
                          </div>
                        ) : (
                          m.body && (
                            <p className="text-md" style={{ margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                              {m.body}
                            </p>
                          )
                        )}
                        {m.attachments.length > 0 && (
                          <div className="row gap-2" style={{ flexWrap: "wrap", marginTop: 6 }}>
                            {m.attachments.map(a => <AttachmentPill key={a.id} a={a} />)}
                          </div>
                        )}
                      </div>
                    </div>
                    {i < visible.length - 1 && <hr className="divider" style={{ marginTop: 20 }} />}
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Who a message reaches is the composer's Reply / Internal note
              switch; switching to the Internal tab flips it to a note, and
              back to Customer flips it to a reply. It's hidden (not
              unmounted) on the Trail, so a draft survives a look at it. */}
          <div hidden={tab === "trail"}>
            <ReplyComposer
              itemShortId={item.shortId}
              status={shown}
              submitterName={submitter.name}
              accountName={account.name}
              source={item.source}
              notifyPlan={notifyPlan}
              teammates={teammates}
              aiReplyAvailable={aiReplyAvailable}
              canWrite={canWrite}
              onSent={() => router.refresh()}
              tabMode={tab === "internal" ? "note" : tab === "customer" ? "reply" : undefined}
            />
          </div>
        </Card>

        <div className="col gap-4">
          {/* Details first: who this loop belongs to, what they're worth, and
              the item's editable properties (owner, type). */}
          <Card>
            <CardHead title="Details" />
            <div className="card-body col gap-3">
              <Link href={`/accounts/${account.id}`} className="row gap-3 center"
                style={{ textDecoration: "none", color: "inherit" }}>
                <Avatar kind="ink">{account.name[0]}</Avatar>
                <div className="col grow">
                  <span className="serif text-md">{account.name}</span>
                  <span className="text-xs muted">{formatArr(account.arrCents)}</span>
                </div>
                <Ic.chevR style={{ width: 12, height: 12, color: "var(--mute-2)" }} />
              </Link>
              <span className="eyebrow">Submitter</span>
              <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
                <Avatar size="sm">{submitter.initials}</Avatar>
                <span className="text-sm">{submitter.name}</span>
                {item.source && (item.sourceUrl ? (
                  <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-xs muted">
                    via {sourceLabel(item.source)}
                  </a>
                ) : (
                  <span className="text-xs muted">via {sourceLabel(item.source)}</span>
                ))}
              </div>
              <span className="eyebrow">Assignee</span>
              {canWrite ? (
                <Dropdown
                  size="sm"
                  ariaLabel="Assignee"
                  placeholder="Unassigned"
                  value={assignee?.id ?? null}
                  disabled={pending}
                  searchable={teammates.length > 8}
                  onChange={onAssign}
                  options={[
                    { value: "__unassign", label: "Unassigned" },
                    ...teammates.map(t => ({ value: t.id, label: t.name })),
                  ]}
                />
              ) : assignee ? (
                <div className="row gap-2 center">
                  <Avatar size="sm" kind="ink">{assignee.initials}</Avatar>
                  <span className="text-sm">{assignee.name}</span>
                </div>
              ) : (
                <span className="text-sm muted">Unassigned</span>
              )}
              <span className="eyebrow">Type</span>
              {canWrite ? (
                <Dropdown
                  size="sm"
                  ariaLabel="Type"
                  placeholder={item.type}
                  value={item.type}
                  disabled={pending}
                  onChange={onType}
                  options={[
                    { value: "bug", label: "Bug" },
                    { value: "idea", label: "Idea" },
                    { value: "question", label: "Question" },
                  ]}
                />
              ) : (
                <span className="text-sm" style={{ textTransform: "capitalize" }}>{item.type}</span>
              )}
            </div>
          </Card>

          <Card>
            <CardHead title="Status" />
            <div className="card-body col gap-1">
              {shown === "resolved" && (
                // "resolved" is customer-only — it isn't one of the settable
                // rows below, so surface the current state explicitly. The vendor
                // can still pick another status to reopen the loop.
                <span className="row gap-2 center text-xs" style={{ marginBottom: 6, color: "var(--green)" }}>
                  <StatusDot status="resolved" />
                  The customer closed this request.
                </span>
              )}
              {!canWrite && <span className="text-xs muted" style={{ marginBottom: 4 }}>Viewers can't change status.</span>}
              {canWrite && !notifyPlan.status.willEmail && (
                <p className="note text-xs muted" style={{ marginBottom: 6 }}>
                  {noEmailNote(notifyPlan.status, "status", first, item.source)}
                </p>
              )}
              {/* All 8 vendor statuses in one column. The reason-required ones
                  open an inline reason form below their row; the ones that
                  will email the customer say so. */}
              {VENDOR_STATUS_OPTIONS.map(({ value: s, label: l }) => {
                const isCurrent = shown === s;
                // Going back to the saved status is an undo, so no reason.
                const needsReason = REASON_REQUIRED.has(s) && s !== item.status;
                const hint = isCurrent ? "" : [
                  needsReason && "say why",
                  statusWillEmail(s, item.status, notifyPlan.status) && `emails ${first}`,
                ].filter(Boolean).join(" · ");
                return (
                  <div key={s}>
                    <button
                      onClick={() => {
                        if (isCurrent) return;
                        if (needsReason) setReasonFor(s);
                        else void statusMove.move(s);
                      }}
                      disabled={statusMove.saving || isCurrent || !canWrite}
                      className="nav-item"
                      aria-selected={isCurrent}
                      style={{ justifyContent: "flex-start", gap: 12, width: "100%" }}
                    >
                      <StatusDot status={s} />
                      <span className={isCurrent ? "fw-med" : ""}>{l}</span>
                      {hint && <span className="text-2xs muted" style={{ marginLeft: "auto" }}>{hint}</span>}
                    </button>

                    {reasonFor === s && (
                      <div className="col gap-2" style={{
                        margin: "6px 0 10px",
                        padding: 12,
                        border: "var(--border)",
                        borderRadius: "var(--r-sm)",
                        background: "var(--surface-2)",
                      }}>
                        <textarea
                          className="input"
                          rows={3}
                          aria-label={`Reason for ${l}`}
                          placeholder={REASON_PLACEHOLDER[s]}
                          value={reasonText}
                          onChange={e => setReasonText(e.target.value)}
                          disabled={statusMove.saving}
                          autoFocus
                        />
                        <div className="row gap-2">
                          <Btn sm onClick={() => { setReasonFor(null); setReasonText(""); }} disabled={statusMove.saving}>Cancel</Btn>
                          <Btn sm variant="primary" onClick={submitReason} disabled={statusMove.saving || !reasonText.trim()}>
                            Mark {l}
                          </Btn>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          <InitiativePanel
            itemShortId={item.shortId}
            current={initiative}
            options={initiativeOptions}
            canManage={canManageInitiatives}
          />

          {!initiative && suggestion && canManageInitiatives && (
            <ThreadSuggestionCard suggestion={suggestion} itemShortId={item.shortId} />
          )}

          {canManageInitiatives && (
            <MergePanel itemShortId={item.shortId} canManage={canWrite} merge={merge} />
          )}

          <ExternalTicketTile
            itemShortId={item.shortId}
            itemTitle={item.title}
            itemBody={item.body}
            aiAvailable={aiTicketAvailable}
            workspace={workspaceIntegrations}
            item={{
              externalProvider:  item.externalProvider,
              externalTicketId:  item.externalTicketId,
              externalTicketUrl: item.externalTicketUrl,
              externalStatus:    item.externalStatus,
              externalSyncedAt:  item.externalSyncedAt,
            }}
          />

          {replay && <ReplaySessionCard replay={replay} />}

          {usageBreadcrumb && usageBreadcrumb.length > 0 && <UsageBreadcrumbCard entries={usageBreadcrumb} />}

        </div>
      </div>
    </>
  );
}
