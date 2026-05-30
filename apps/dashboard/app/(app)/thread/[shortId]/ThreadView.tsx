"use client";

import { useMemo, useRef, useState, useTransition, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar, Btn, Card, CardHead, Ic, PageHead, Pill, StatusDot, StatusPill } from "@crumb/ui";
import type { Status } from "@crumb/ui";
import { createReply, updateStatus } from "./actions";
import { InitiativePanel, type ThreadInitiativeOption } from "./InitiativePanel";
import { ThreadSuggestionCard, type ThreadSuggestion } from "./ThreadSuggestionCard";
import { ExternalTicketTile } from "./ExternalTicketTile";
import { ReplaySessionCard, type ReplayCardData } from "./ReplaySessionCard";

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
  declined:  "e.g. We're not building this in v2 — the maintenance cost is too high for the use case.",
  deferred:  "e.g. Revisiting in Q3 once the new export pipeline ships.",
  duplicate: "e.g. Tracked under FB-242 — replies there will reach you.",
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
  };
  account: { id: string; name: string; arrCents: number };
  submitter: { name: string; initials: string };
  assignee: { initials: string; name: string } | null;
  messages: ThreadMessage[];
  events: ThreadStatusEvent[];
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
  replay: ReplayCardData | null;
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
};

type TrailEntry =
  | { kind: "message"; at: string; msg: ThreadMessage }
  | { kind: "event";   at: string; event: ThreadStatusEvent };

export function ThreadView({ data, canWrite }: { data: ThreadData; canWrite: boolean }) {
  const router = useRouter();
  const { item, account, submitter, assignee, messages, events, teammates, initiative, initiativeOptions, canManageInitiatives, suggestion, workspaceIntegrations, aiTicketAvailable, replay } = data;
  const teammateNames = useMemo(() => teammates.map(t => t.name), [teammates]);

  const customerMsgs = messages.filter(m => !m.internal);
  const internalMsgs = messages.filter(m => m.internal);

  const trail: TrailEntry[] = useMemo(() => {
    const all: TrailEntry[] = [
      ...messages.filter(m => !m.internal).map(msg => ({ kind: "message" as const, at: msg.createdAt, msg })),
      ...events.map(event => ({ kind: "event" as const, at: event.at, event })),
    ];
    all.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    return all;
  }, [messages, events]);

  const [tab, setTab] = useState<"customer" | "internal" | "trail">("customer");
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const [reasonForm, setReasonForm] = useState<{ status: Status; label: string } | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<ThreadAttachment[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

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
    if (tab !== "internal") { setMention(null); return; }
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

  function onDraftChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
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
    // Spin up a hidden <input type="file"> on-demand so we don't clutter
    // the DOM with a permanently-mounted picker.
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
          setUploadError(data?.error || `Upload failed (${res.status})`);
        } else {
          setPendingAttachments(prev => [...prev, {
            id: data.id,
            filename: data.filename,
            contentType: data.content_type,
            sizeBytes: data.size_bytes,
          }]);
        }
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    };
    input.click();
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments(prev => prev.filter(a => a.id !== id));
  }

  // Auto-clear the "Sent" confirmation after a moment so it doesn't
  // linger past the next interaction.
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
        itemShortId: item.shortId,
        body,
        internal: tab === "internal",
        attachmentIds,
      });
      if (res.ok) {
        setDraft("");
        setPendingAttachments([]);
        setSentAt(Date.now());
        router.refresh();
      }
    });
  };

  const onStatus = (next: Status) => {
    startTransition(async () => {
      const res = await updateStatus({ itemShortId: item.shortId, status: next });
      if (res.ok) router.refresh();
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

  const visible = tab === "customer" ? customerMsgs : internalMsgs;

  return (
    <>
      <PageHead
        crumb={<><span>Inbox</span><Ic.chevR style={{ width: 10, height: 10 }} /><span className="mono">{item.shortId}</span></>}
        title={item.title}
        actions={
          <>
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

      <div className="cols-2-1" style={{ alignItems: "start" }}>
        <Card>
          <div className="card-body col gap-5">
            {tab === "trail" ? (
              trail.length === 0 ? (
                <p className="text-sm muted" style={{ margin: 0 }}>
                  Nothing here yet. Replies and status changes will land in this trail.
                </p>
              ) : (
                <div className="col gap-4" style={{ position: "relative", paddingLeft: 18 }}>
                  <div style={{
                    position: "absolute",
                    left: 5, top: 6, bottom: 6, width: 1,
                    background: "var(--hair-strong)",
                  }} />
                  {trail.map(entry => entry.kind === "event" ? (
                    <div key={`e:${entry.event.id}`} className="row gap-3" style={{ alignItems: "flex-start", position: "relative" }}>
                      <span style={{
                        width: 11, height: 11, borderRadius: 999,
                        background: "var(--accent)",
                        marginLeft: -18, marginRight: 7, flexShrink: 0,
                        marginTop: 6,
                      }} />
                      <div className="col grow gap-1">
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
                      <span className="text-xs muted mono">{relAge(entry.at)}</span>
                    </div>
                  ) : (
                    <div key={`m:${entry.msg.id}`} className="row gap-3" style={{ alignItems: "flex-start", position: "relative" }}>
                      <span style={{
                        width: 11, height: 11, borderRadius: 999,
                        background: "var(--cream-2)",
                        border: "var(--border-strong)",
                        marginLeft: -18, marginRight: 7, flexShrink: 0,
                        marginTop: 6,
                      }} />
                      <div className="col grow gap-1">
                        <span className="text-sm">
                          <span className="fw-med">{entry.msg.authorName}</span>
                          <span className="muted"> replied</span>
                        </span>
                        <p className="text-sm" style={{ margin: 0, lineHeight: 1.55, color: "var(--text)" }}>
                          {entry.msg.body.length > 160 ? entry.msg.body.slice(0, 159) + "…" : entry.msg.body}
                        </p>
                      </div>
                      <span className="text-xs muted mono">{relAge(entry.at)}</span>
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

          <div className="card-foot col gap-3" style={{ alignItems: "stretch" }}>
            <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
              <Pill ring ringFill={tab !== "internal"}>
                {tab === "internal" ? "Internal only" : `Replying to ${submitter.name} — ${account.name} can see this`}
              </Pill>
              {!canWrite && tab !== "internal" && (
                <span className="text-xs muted">Viewers can only post internal notes — switch to the Internal tab.</span>
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
                placeholder={tab === "internal" ? "Internal note — type @ to mention a teammate. (Acme can't see this.)" : "Write a reply."}
                value={draft}
                onChange={onDraftChange}
                onKeyDown={onComposerKeyDown}
                onBlur={() => setTimeout(() => setMention(null), 120)}
                disabled={pending}
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
                      aria-label="Remove attachment"
                    >
                      <Ic.x style={{ width: 11, height: 11 }} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {uploadError && (
              <span className="text-xs" style={{ color: "var(--err-text)" }}>{uploadError}</span>
            )}
            <div className="row gap-2 center">
              <Btn
                variant="ghost"
                iconOnly
                icon={<Ic.attach style={{ width: 13, height: 13 }} />}
                onClick={pickAndUpload}
                disabled={pending || uploading}
                aria-label="Attach a file"
              />
              {uploading && <span className="text-xs muted">Uploading…</span>}
              <div style={{ flex: 1 }} />
              <Btn sm onClick={() => { setDraft(""); setPendingAttachments([]); }} disabled={pending || (!draft && pendingAttachments.length === 0)}>Clear</Btn>
              <Btn sm variant="primary" icon={<Ic.send style={{ width: 12, height: 12 }} />} onClick={onSend} disabled={pending || (!draft.trim() && pendingAttachments.length === 0) || (!canWrite && tab !== "internal")}>
                {pending ? "Sending…" : "Send"}
              </Btn>
            </div>
          </div>
        </Card>

        <div className="col gap-4">
          <Card>
            <CardHead title="Status" />
            <div className="card-body col gap-1">
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

          <Card>
            <CardHead title="Account" />
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
              {assignee && (
                <>
                  <span className="eyebrow">Assignee</span>
                  <div className="row gap-2 center">
                    <Avatar size="sm" kind="ink">{assignee.initials}</Avatar>
                    <span className="text-sm">{assignee.name}</span>
                  </div>
                </>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
