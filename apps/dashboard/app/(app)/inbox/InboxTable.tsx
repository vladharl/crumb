"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar, Btn, Card, Ic, Pill, StatusPill, TypeChip } from "@crumb/ui";
import type { Status, TypeKind } from "@crumb/ui";
import { bulkAssign, bulkUpdateStatus, acceptTriageAssignee, dismissTriage } from "./actions";
import { bulkSetInitiative, clusterItems, acceptSuggestion, dismissSuggestion } from "../initiatives/actions";
import { InitiativeChip } from "../initiatives/InitiativeChip";

export type TriageAssignee = { id: string; initials: string; name: string };

export type InboxSuggestion = {
  id: string;
  initiativeId: string;
  initiativeName: string;
  initiativeColor: string | null;
  confidence: number;
  reason: string | null;
};

export type InboxRow = {
  id: string;
  shortId: string;
  title: string;
  type: string;
  status: string;
  assigneeId: string | null;
  createdAtIso: string;
  accountName: string;
  submitterName: string;
  assigneeInitials: string | null;
  replyCount: number;
  initiativeId: string | null;
  initiativeName: string | null;
  initiativeColor: string | null;
  suggestion: InboxSuggestion | null;
  // AI triage (feature 3) — advisory, shown as badges/chips, never auto-applied.
  aiSeverity: string | null;
  aiSentiment: number | null;
  aiTriageReason: string | null;
  aiSuggestedAssignee: TriageAssignee | null;
  // Merge (feature 4)
  mergedIntoId: string | null;
  mergedCount: number;
};

export type Assignee = {
  id: string;
  name: string;
  initials: string;
};

export type InitiativeOption = {
  id: string;
  name: string;
  color: string | null;
  status: string;
};

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

const GRID = "28px 64px 86px 1.4fr 110px 140px 110px 56px 56px 22px";
const INITIATIVE_ANY = "__any";
const INITIATIVE_NONE = "__none";

function ageFrom(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return "now";
  const units: Array<[string, number]> = [
    ["w", 1000 * 60 * 60 * 24 * 7],
    ["d", 1000 * 60 * 60 * 24],
    ["h", 1000 * 60 * 60],
    ["m", 1000 * 60],
  ];
  for (const [u, ms] of units) if (d >= ms) return `${Math.floor(d / ms)}${u}`;
  return "now";
}

type Tab = "all" | "open" | "mine";

export function InboxTable({
  rows, assignees, meId, canWrite, aiEntitled, initiatives, canManageInitiatives, clusterEnabled,
}: {
  rows: InboxRow[];
  assignees: Assignee[];
  meId: string;
  canWrite: boolean;
  aiEntitled: boolean;
  initiatives: InitiativeOption[];
  canManageInitiatives: boolean;
  clusterEnabled: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [initiativeFilter, setInitiativeFilter] = useState<string>(INITIATIVE_ANY);
  // Merged duplicates (feature 4) are hidden from the default view — they live
  // under their canonical item. Toggle to audit them.
  const [showMerged, setShowMerged] = useState(false);

  const openCount = useMemo(() => rows.filter(r => r.status === "open").length, [rows]);
  const mineCount = useMemo(() => rows.filter(r => r.assigneeId === meId).length, [rows, meId]);
  const mergedTotal = useMemo(() => rows.filter(r => r.mergedIntoId !== null).length, [rows]);

  // Combined tab + search filter. Client-side so the UI is instant; bulk
  // ops below operate on the filtered visible set.
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(r => {
      if (!showMerged && r.mergedIntoId !== null) return false;
      if (tab === "open" && r.status !== "open") return false;
      if (tab === "mine" && r.assigneeId !== meId) return false;
      if (initiativeFilter === INITIATIVE_NONE && r.initiativeId !== null) return false;
      if (initiativeFilter !== INITIATIVE_ANY && initiativeFilter !== INITIATIVE_NONE && r.initiativeId !== initiativeFilter) return false;
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        r.shortId.toLowerCase().includes(q) ||
        r.accountName.toLowerCase().includes(q) ||
        r.submitterName.toLowerCase().includes(q) ||
        (r.initiativeName?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rows, tab, query, meId, initiativeFilter, showMerged]);

  const allSelected = visibleRows.length > 0 && selected.size === visibleRows.length;
  const someSelected = selected.size > 0 && !allSelected;

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visibleRows.map(r => r.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function applyStatus(status: string) {
    if (!status || selected.size === 0) return;
    const ids = Array.from(selected);
    startTransition(async () => {
      const r = await bulkUpdateStatus(ids, status);
      if (r.ok) {
        clearSelection();
        router.refresh();
      }
    });
  }

  function applyAssign(value: string) {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    const assigneeId = value === "__unassign" ? null : value;
    startTransition(async () => {
      const r = await bulkAssign(ids, assigneeId);
      if (r.ok) {
        clearSelection();
        router.refresh();
      }
    });
  }

  function clusterSelected() {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    startTransition(async () => {
      const r = await clusterItems(ids);
      if (r.ok) {
        clearSelection();
        router.refresh();
      }
    });
  }

  function onAccept(suggestionId: string) {
    startTransition(async () => {
      const r = await acceptSuggestion(suggestionId);
      if (r.ok) router.refresh();
    });
  }

  function onDismiss(suggestionId: string) {
    startTransition(async () => {
      const r = await dismissSuggestion(suggestionId);
      if (r.ok) router.refresh();
    });
  }

  function onAcceptTriage(itemId: string) {
    startTransition(async () => {
      const r = await acceptTriageAssignee(itemId);
      if (r.ok) router.refresh();
    });
  }

  function onDismissTriage(itemId: string) {
    startTransition(async () => {
      const r = await dismissTriage(itemId);
      if (r.ok) router.refresh();
    });
  }

  function applyInitiative(value: string) {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    const initiativeId = value === "__clear" ? null : value;
    startTransition(async () => {
      const r = await bulkSetInitiative(ids, initiativeId);
      if (r.ok) {
        clearSelection();
        router.refresh();
      }
    });
  }

  return (
    <>
      {selected.size === 0 ? (
        <div className="row gap-3 center" style={{ flexWrap: "wrap" }}>
          <div className="row gap-2 center" style={{
            flex: 1, minWidth: 220,
            border: "var(--border)", borderRadius: "var(--r-sm)",
            padding: "6px 10px",
          }}>
            <Ic.search style={{ width: 13, height: 13, color: "var(--mute-2)" }} />
            <input
              className="input search"
              placeholder="Search feedback, accounts, people"
              value={query}
              onChange={e => setQuery(e.target.value)}
              style={{ border: 0, padding: 0 }}
            />
          </div>
          <div className="seg">
            <button aria-selected={tab === "all"}  onClick={() => setTab("all")}>All · {rows.length}</button>
            <button aria-selected={tab === "open"} onClick={() => setTab("open")}>Open · {openCount}</button>
            <button aria-selected={tab === "mine"} onClick={() => setTab("mine")}>Mine · {mineCount}</button>
          </div>
          {initiatives.length > 0 && (
            <select
              className="input text-sm"
              value={initiativeFilter}
              onChange={e => setInitiativeFilter(e.target.value)}
              aria-label="Filter by initiative"
              style={{ padding: "6px 10px", height: 32, minWidth: 180 }}
            >
              <option value={INITIATIVE_ANY}>Initiative · all</option>
              <option value={INITIATIVE_NONE}>No initiative</option>
              {initiatives.map(i => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          )}
          {mergedTotal > 0 && (
            <label className="row gap-2 center text-sm muted" style={{ flex: "0 0 auto", cursor: "pointer" }} title="Show duplicates that were merged into another item">
              <input type="checkbox" checked={showMerged} onChange={e => setShowMerged(e.target.checked)} style={{ cursor: "pointer" }} />
              Merged · {mergedTotal}
            </label>
          )}
        </div>
      ) : (
        <div className="row gap-3 center" style={{
          flexWrap: "wrap",
          padding: "10px 14px",
          border: "1px solid var(--ink)",
          background: "rgba(28, 24, 21, 0.04)",
          borderRadius: "var(--r-sm)",
        }}>
          <span className="fw-med">{selected.size} selected</span>

          {canWrite ? (<>
          <label className="row gap-2 center text-sm" style={{ flex: "0 0 auto" }}>
            <span className="muted">Status</span>
            <select
              className="input"
              disabled={pending}
              defaultValue=""
              onChange={e => { applyStatus(e.target.value); e.currentTarget.value = ""; }}
              style={{ padding: "4px 8px", height: 30 }}
            >
              <option value="" disabled>Set status…</option>
              {STATUS_OPTIONS.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>

          <label className="row gap-2 center text-sm" style={{ flex: "0 0 auto" }}>
            <span className="muted">Assign</span>
            <select
              className="input"
              disabled={pending}
              defaultValue=""
              onChange={e => { applyAssign(e.target.value); e.currentTarget.value = ""; }}
              style={{ padding: "4px 8px", height: 30 }}
            >
              <option value="" disabled>Assign to…</option>
              <option value="__unassign">— Unassign —</option>
              {assignees.map(a => (
                <option key={a.id} value={a.id}>{a.name} ({a.initials})</option>
              ))}
            </select>
          </label>

          {canManageInitiatives && (
            <label className="row gap-2 center text-sm" style={{ flex: "0 0 auto" }}>
              <span className="muted">Initiative</span>
              <select
                className="input"
                disabled={pending}
                defaultValue=""
                onChange={e => { applyInitiative(e.target.value); e.currentTarget.value = ""; }}
                style={{ padding: "4px 8px", height: 30 }}
              >
                <option value="" disabled>Set initiative…</option>
                <option value="__clear">— No initiative —</option>
                {initiatives.map(i => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
            </label>
          )}
          </>) : (
            <span className="text-sm muted">Viewers can't modify items.</span>
          )}

          <div style={{ flex: 1 }} />
          <Btn sm variant="ghost" onClick={clearSelection} disabled={pending}>Clear</Btn>
        </div>
      )}

      <Card style={{ padding: 0 }}>
        <div className="list" role="table" aria-label="Feedback inbox">
          <div className="list-row head" role="row" style={{ gridTemplateColumns: GRID }}>
            <span role="columnheader">
              <input
                type="checkbox"
                checked={allSelected}
                ref={el => { if (el) el.indeterminate = someSelected; }}
                onChange={toggleAll}
                aria-label="Select all"
                style={{ cursor: "pointer" }}
              />
            </span>
            <span role="columnheader">ID</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Title</span>
            <span role="columnheader">Account · by</span>
            <span role="columnheader">Initiative</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Asg.</span>
            <span role="columnheader">Age</span>
            <span role="columnheader"></span>
          </div>

          {visibleRows.length === 0 && (
            <div className="card-body" role="row">
              <p className="text-sm muted" role="cell" style={{ margin: 0 }}>
                {rows.length === 0
                  ? "No feedback yet — share your widget snippet with customers to see things flow in here."
                  : "Nothing matches that filter."}
              </p>
            </div>
          )}
          {visibleRows.map(it => {
            const isSel = selected.has(it.id);
            return (
              <div
                key={it.id}
                className={`list-row ${isSel ? "selected" : ""}`}
                role="row"
                style={{ gridTemplateColumns: GRID }}
              >
                <span>
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={() => toggle(it.id)}
                    aria-label={`Select ${it.shortId}`}
                    style={{ cursor: "pointer" }}
                  />
                </span>
                <Link href={`/thread/${it.shortId}`} className="text-2xs mono muted" style={{ textDecoration: "none" }}>
                  {it.shortId}
                </Link>
                <Link href={`/thread/${it.shortId}`} style={{ textDecoration: "none", color: "inherit" }}>
                  <TypeChip type={it.type as TypeKind} />
                </Link>
                <Link href={`/thread/${it.shortId}`} className="col gap-1 grow truncate" style={{ textDecoration: "none", color: "inherit" }}>
                  <span className="fw-med truncate" style={{ display: "block" }}>{it.title}</span>
                  <span className="text-xs muted row gap-2 center" style={{ flexWrap: "wrap" }}>
                    {aiEntitled && it.aiSeverity && <SeverityBadge severity={it.aiSeverity} reason={it.aiTriageReason} />}
                    {aiEntitled && it.aiSentiment !== null && <SentimentGlyph score={it.aiSentiment} />}
                    {it.replyCount > 0 && (
                      <span className="row gap-1 center">
                        <Ic.chat style={{ width: 10, height: 10 }} />
                        {it.replyCount} {it.replyCount === 1 ? "reply" : "replies"}
                      </span>
                    )}
                    {it.mergedCount > 0 && (
                      <span className="row gap-1 center" title={`${it.mergedCount} duplicate${it.mergedCount === 1 ? "" : "s"} merged in`}>
                        <Ic.copy style={{ width: 10, height: 10 }} />
                        {it.mergedCount} merged
                      </span>
                    )}
                  </span>
                </Link>
                <Link href={`/thread/${it.shortId}`} className="col gap-1 truncate" style={{ textDecoration: "none", color: "inherit" }}>
                  <span className="fw-med text-sm">{it.accountName}</span>
                  <span className="text-xs muted">{it.submitterName}</span>
                </Link>
                <div style={{ minWidth: 0 }}>
                  {it.initiativeId ? (
                    <Link href={`/thread/${it.shortId}`} style={{ textDecoration: "none", color: "inherit", minWidth: 0 }}>
                      <InitiativeChip
                        initiative={{
                          id: it.initiativeId,
                          shortId: "",
                          name: it.initiativeName ?? "",
                          color: it.initiativeColor,
                          status: "",
                        }}
                      />
                    </Link>
                  ) : it.suggestion && canManageInitiatives ? (
                    <SuggestionChip
                      suggestion={it.suggestion}
                      onAccept={() => onAccept(it.suggestion!.id)}
                      onDismiss={() => onDismiss(it.suggestion!.id)}
                      disabled={pending}
                    />
                  ) : (
                    <Link href={`/thread/${it.shortId}`} style={{ textDecoration: "none", color: "inherit" }}>
                      <span className="muted-2">—</span>
                    </Link>
                  )}
                </div>
                <Link href={`/thread/${it.shortId}`} style={{ textDecoration: "none" }}>
                  <StatusPill status={it.status as Status} />
                </Link>
                {it.assigneeInitials ? (
                  <Link href={`/thread/${it.shortId}`} style={{ textDecoration: "none", color: "inherit" }}>
                    <Avatar size="sm">{it.assigneeInitials}</Avatar>
                  </Link>
                ) : aiEntitled && canWrite && it.aiSuggestedAssignee ? (
                  <TriageAssigneeChip
                    assignee={it.aiSuggestedAssignee}
                    reason={it.aiTriageReason}
                    onAccept={() => onAcceptTriage(it.id)}
                    onDismiss={() => onDismissTriage(it.id)}
                    disabled={pending}
                  />
                ) : (
                  <Link href={`/thread/${it.shortId}`} style={{ textDecoration: "none", color: "inherit" }}>
                    <span className="text-xs muted-2">—</span>
                  </Link>
                )}
                <Link href={`/thread/${it.shortId}`} className="text-xs muted mono" style={{ textDecoration: "none" }}>
                  {ageFrom(it.createdAtIso)}
                </Link>
                <Ic.more style={{ width: 14, height: 14, color: "var(--mute-2)" }} />
              </div>
            );
          })}
        </div>
      </Card>

      <div className="row between" style={{ flexWrap: "wrap", gap: 12 }}>
        <span className="text-sm muted">Showing {visibleRows.length} of {rows.length}</span>
        {/* Cluster these: AI-only feature. Hidden entirely on self-host;
            on Cloud, enabled when a key is set + at least one initiative
            exists, otherwise the disabled hint nudges setup. */}
        {aiEntitled && canManageInitiatives && (
          <div className="row gap-2 center">
            <Btn
              sm
              icon={<Ic.sparkle style={{ width: 11, height: 11 }} />}
              disabled={!clusterEnabled || pending || selected.size === 0}
              onClick={clusterSelected}
            >
              {pending ? "Clustering…" : `Cluster selected${selected.size > 0 ? ` (${selected.size})` : ""}`}
            </Btn>
            {!clusterEnabled && (
              <Pill ring>{initiatives.length === 0 ? "Add an initiative first" : "Set ANTHROPIC_API_KEY"}</Pill>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function SuggestionChip({
  suggestion, onAccept, onDismiss, disabled,
}: {
  suggestion: InboxSuggestion;
  onAccept: () => void;
  onDismiss: () => void;
  disabled: boolean;
}) {
  const dot = suggestion.initiativeColor ?? "var(--ink)";
  const title = suggestion.reason
    ? `${suggestion.reason} · ${Math.round(suggestion.confidence * 100)}% confidence`
    : `${Math.round(suggestion.confidence * 100)}% confidence`;
  return (
    <span className="row gap-2 center" style={{ minWidth: 0 }} title={title}>
      <Ic.sparkle style={{ width: 11, height: 11, color: "var(--mute-2)", flexShrink: 0 }} />
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0 }}
      />
      <span className="text-sm truncate" style={{ minWidth: 0 }}>{suggestion.initiativeName}</span>
      <button
        type="button"
        aria-label="Accept suggestion"
        disabled={disabled}
        onClick={e => { e.stopPropagation(); onAccept(); }}
        style={iconBtn}
      >
        <Ic.check style={{ width: 11, height: 11 }} />
      </button>
      <button
        type="button"
        aria-label="Dismiss suggestion"
        disabled={disabled}
        onClick={e => { e.stopPropagation(); onDismiss(); }}
        style={iconBtn}
      >
        <Ic.x style={{ width: 11, height: 11 }} />
      </button>
    </span>
  );
}

const iconBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  border: "1px solid var(--line)",
  borderRadius: 4,
  background: "var(--paper)",
  color: "var(--ink)",
  cursor: "pointer",
  padding: 0,
  flexShrink: 0,
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--rust-deep)",
  high: "var(--rust)",
  medium: "var(--amber)",
  low: "var(--mute-2)",
};

// Small severity dot + label shown in the inbox row meta line (feature 3).
function SeverityBadge({ severity, reason }: { severity: string; reason: string | null }) {
  const color = SEVERITY_COLOR[severity] ?? "var(--mute-2)";
  return (
    <span className="row gap-1 center" title={reason ? `AI severity: ${severity} · ${reason}` : `AI severity: ${severity}`}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />
      {severity}
    </span>
  );
}

// Sentiment arrow: down/red (negative), up/green (positive), neutral hidden as
// a muted dash. Threshold ±0.2 keeps near-neutral scores quiet.
function SentimentGlyph({ score }: { score: number }) {
  let color = "var(--mute-2)";
  let label = "neutral";
  let arrow = "→";
  if (score <= -0.2) { color = "var(--rust)"; label = "negative"; arrow = "↓"; }
  else if (score >= 0.2) { color = "var(--green)"; label = "positive"; arrow = "↑"; }
  return (
    <span className="row gap-1 center" style={{ color }} title={`AI sentiment: ${label} (${score.toFixed(2)})`}>
      <span aria-hidden style={{ fontWeight: 700 }}>{arrow}</span>
    </span>
  );
}

const ghostAvatar: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: "50%",
  border: "1px dashed var(--accent)",
  background: "var(--accent-soft)",
  color: "var(--accent-deep)",
  fontSize: 9,
  fontWeight: 600,
  cursor: "pointer",
  padding: 0,
  flexShrink: 0,
};

const iconBtnXs: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  border: "1px solid var(--line)",
  borderRadius: 4,
  background: "var(--paper)",
  color: "var(--mute)",
  cursor: "pointer",
  padding: 0,
  flexShrink: 0,
};

// AI-suggested assignee (feature 3): a dashed "ghost" avatar that assigns on
// click, plus a dismiss. Shown only when the item is unassigned and the
// triage model proposed an owner.
function TriageAssigneeChip({
  assignee, reason, onAccept, onDismiss, disabled,
}: {
  assignee: TriageAssignee;
  reason: string | null;
  onAccept: () => void;
  onDismiss: () => void;
  disabled: boolean;
}) {
  const title = reason ? `AI suggests ${assignee.name} · ${reason}` : `AI suggests ${assignee.name}`;
  return (
    <span className="row gap-1 center" style={{ minWidth: 0 }} title={title}>
      <button
        type="button"
        aria-label={`Assign to ${assignee.name}`}
        disabled={disabled}
        onClick={e => { e.stopPropagation(); onAccept(); }}
        style={ghostAvatar}
      >
        {assignee.initials}
      </button>
      <button
        type="button"
        aria-label="Dismiss suggested assignee"
        disabled={disabled}
        onClick={e => { e.stopPropagation(); onDismiss(); }}
        style={iconBtnXs}
      >
        <Ic.x style={{ width: 9, height: 9 }} />
      </button>
    </span>
  );
}
