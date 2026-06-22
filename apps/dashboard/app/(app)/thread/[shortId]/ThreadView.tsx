"use client";

import { useMemo, useState, useTransition, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar, Btn, Card, CardHead, Dropdown, Ic, PageHead, Pill, StatusDot, StatusPill, TrailDots, trailProgress } from "@crumb/ui";
import type { Status } from "@crumb/ui";
import { updateStatus, translateItem, assignItem, updateType } from "./actions";
import { ReplyComposer } from "@/components/ReplyComposer";
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

const REASON_REQUIRED: Set<Status> = new Set(["declined", "deferred", "duplicate"]);
const REASON_PLACEHOLDER: Record<string, string> = {
  declined:  "e.g. We're not building this in v2. The maintenance cost is too high for the use case.",
  deferred:  "e.g. Revisiting in Q3 once the new export pipeline ships.",
  duplicate: "e.g. Tracked under FB-242. Replies there will reach you.",
};

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
  };
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

// Unified status list — all 8 in one column. The 3 reason-required
// statuses (declined / deferred / duplicate) trigger an inline reason
// form below their row when clicked, instead of living in a separate
// "actions" block. Keeps the panel one mental model.
const STATUS_ROWS: Array<[label: string, status: Status]> = [
  ["Open",        "open"],
  ["In review",   "review"],
  ["Planned",     "planned"],
  ["In progress", "progress"],
  ["Shipped",     "shipped"],
  ["Won’t ship",  "declined"],
  ["Set aside",   "deferred"],
  ["Duplicate",   "duplicate"],
];

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

const STATUS_LABEL_MAP: Record<string, string> = {
  open: "Open", review: "In review", planned: "Planned", progress: "In progress",
  shipped: "Shipped", declined: "Won’t ship", deferred: "Set aside", duplicate: "Duplicate",
  resolved: "Resolved",
};

type TrailEntry =
  | { kind: "message"; at: string; msg: ThreadMessage }
  | { kind: "event";   at: string; event: ThreadStatusEvent }
  | { kind: "notice";  at: string; notice: ThreadNotice };

export function ThreadView({ data, canWrite }: { data: ThreadData; canWrite: boolean }) {
  const router = useRouter();
  const { item, account, submitter, assignee, messages, events, notices, teammates, initiative, initiativeOptions, canManageInitiatives, suggestion, workspaceIntegrations, aiTicketAvailable, aiReplyAvailable, replay, usageBreadcrumb, merge } = data;
  const teammateNames = useMemo(() => teammates.map(t => t.name), [teammates]);

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

  const progress = useMemo(() => trailProgress({
    status: item.status,
    vendorReplied: messages.some(m => m.kind === "vendor" && !m.internal),
  }), [item.status, messages]);

  const [tab, setTab] = useState<"customer" | "internal" | "trail">("customer");
  const [pending, startTransition] = useTransition();
  const [reasonForm, setReasonForm] = useState<{ status: Status; label: string } | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);

  const onStatus = (next: Status) => {
    startTransition(async () => {
      const res = await updateStatus({ itemShortId: item.shortId, status: next });
      if (res.ok) router.refresh();
    });
  };

  const onTranslate = () => {
    startTransition(async () => {
      const res = await translateItem(item.shortId);
      if (res.ok) { setShowTranslation(true); router.refresh(); }
    });
  };

  const openReasonFor = (status: Status, label: string) => {
    setReasonForm({ status, label });
    setReasonText("");
    setReasonError(null);
  };

  const submitReason = () => {
    if (!reasonForm) return;
    const reason = reasonText.trim();
    if (!reason) {
      setReasonError("A reason is required so the customer sees the why.");
      return;
    }
    startTransition(async () => {
      const res = await updateStatus({
        itemShortId: item.shortId,
        status: reasonForm.status,
        reason,
      });
      if (res.ok) {
        setReasonForm(null);
        setReasonText("");
        router.refresh();
      } else {
        setReasonError(res.error === "reason_required" ? "A reason is required." : res.error);
      }
    });
  };

  // Details-card property edits (assignee / type) — single-item, in place.
  function onAssign(value: string) {
    startTransition(async () => {
      const res = await assignItem(item.shortId, value === "__unassign" ? null : value);
      if (res.ok) router.refresh();
    });
  }

  function onType(value: string) {
    startTransition(async () => {
      const res = await updateType(item.shortId, value);
      if (res.ok) router.refresh();
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
            <StatusPill status={item.status as Status} />
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
                  {trail.map((entry, i) => entry.kind === "notice" ? (
                    <div key={`n:${entry.notice.id}`} className="trail-node" style={{ "--i": i } as CSSProperties}>
                      <span className="trail-crumb notice" aria-hidden />
                      <div className="trail-node-body col grow gap-1">
                        <span className="text-sm">
                          <span className="fw-med">{submitter.name}</span>
                          <span className="muted">
                            {entry.notice.kind === "reply"
                              ? " was notified of the reply"
                              : ` was told it's ${(STATUS_LABEL_MAP[entry.notice.toStatus ?? ""] ?? entry.notice.toStatus ?? "updated").toLowerCase()}`}
                          </span>
                          {entry.notice.kind === "status" && (entry.notice.toStatus === "shipped" || entry.notice.toStatus === "declined") && (
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
                          <strong style={{ fontWeight: 500 }}>{STATUS_LABEL_MAP[entry.event.toStatus] ?? entry.event.toStatus}</strong>
                          {entry.event.fromStatus && (
                            <span className="muted text-xs"> (from {STATUS_LABEL_MAP[entry.event.fromStatus] ?? entry.event.fromStatus})</span>
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
                          <div style={{
                            background: "var(--surface-2)",
                            borderLeft: "3px solid var(--accent)",
                            borderRadius: "0 var(--r-sm) var(--r-sm) 0",
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

          <ReplyComposer
            itemShortId={item.shortId}
            tab={tab}
            submitterName={submitter.name}
            accountName={account.name}
            teammates={teammates}
            aiReplyAvailable={aiReplyAvailable}
            canWrite={canWrite}
            onSent={() => router.refresh()}
          />
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
              <div className="row gap-2 center">
                <Avatar size="sm">{submitter.initials}</Avatar>
                <span className="text-sm">{submitter.name}</span>
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
              {item.status === "resolved" && (
                // "resolved" is customer-only — it isn't one of the settable
                // rows below, so surface the current state explicitly. The vendor
                // can still pick another status to reopen the loop.
                <span className="row gap-2 center text-xs" style={{ marginBottom: 6, color: "var(--green)" }}>
                  <StatusDot status="resolved" />
                  The customer closed this request.
                </span>
              )}
              {!canWrite && <span className="text-xs muted" style={{ marginBottom: 4 }}>Viewers can't change status.</span>}
              {STATUS_ROWS.map(([l, s]) => {
                const isCurrent = item.status === s;
                const needsReason = REASON_REQUIRED.has(s);
                const reasonOpenHere = reasonForm?.status === s;
                return (
                  <div key={s}>
                    <button
                      onClick={() => {
                        if (isCurrent) return;
                        if (needsReason) openReasonFor(s, l);
                        else onStatus(s);
                      }}
                      disabled={pending || isCurrent || !canWrite}
                      className="nav-item"
                      aria-selected={isCurrent}
                      style={{ justifyContent: "flex-start", gap: 12, width: "100%" }}
                    >
                      <StatusDot status={s} />
                      <span className={isCurrent ? "fw-med" : ""}>{l}</span>
                      {needsReason && !isCurrent && (
                        <span className="text-2xs muted" style={{ marginLeft: "auto" }}>say why</span>
                      )}
                    </button>

                    {reasonOpenHere && (
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
                          placeholder={REASON_PLACEHOLDER[reasonForm!.status]}
                          value={reasonText}
                          onChange={e => { setReasonText(e.target.value); setReasonError(null); }}
                          disabled={pending}
                          autoFocus
                        />
                        {reasonError && (
                          <span className="text-xs" style={{ color: "var(--err-text)" }}>{reasonError}</span>
                        )}
                        <div className="row gap-2">
                          <Btn sm onClick={() => setReasonForm(null)} disabled={pending}>Cancel</Btn>
                          <Btn sm variant="primary" onClick={submitReason} disabled={pending || !reasonText.trim()}>
                            {pending ? "Saving…" : `${reasonForm!.label} & notify`}
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
