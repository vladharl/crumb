"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { navigateWithTrailMorph } from "@/lib/view-transition";
import {
  Avatar, BrandMark, Btn, Card, Dropdown, Ic, Pill, StatusPill, TypeChip, trailProgress, statusLabel,
  REASON_REQUIRED, STATUS_LABELS, VENDOR_STATUS_OPTIONS,
} from "@crumb/ui";
import type { Status, TypeKind } from "@crumb/ui";
import { engDoneUntold, loopTurn, waitingDays, waitingSince, type LoopTurn, type ReplySide } from "@/lib/loop";
import { priority, byPriorityDesc, formatArr, type Priority } from "@/lib/priority";
import { gmailTime } from "@/lib/timefmt";
import { splitTerms, matchesTerms } from "@/lib/fuzzy";
import { errorMessage } from "@/lib/action-error";
import { statusEmailsCustomer } from "@/lib/notify/customer-plan";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm";
import { cancelWaitingMove } from "@/components/ReplyComposer";
import { bulkAssign, bulkUpdateStatus, acceptTriageAssignee, dismissTriage } from "./actions";
import { bulkSetInitiative, clusterItems, acceptSuggestion, dismissSuggestion } from "../initiatives/actions";
import { InitiativeChip } from "../initiatives/InitiativeChip";
import { RowActionMenu, ReasonForm, emailNote, statusToast } from "./RowActionMenu";
import { RowReplyDrawer } from "./RowReplyDrawer";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { deleteInboxView, saveInboxView, type SavedView } from "./views-actions";
import {
  ASSIGNEE_ME, ASSIGNEE_NONE, INITIATIVE_NONE, inTab, matchesFilters, readFilters, viewQuery, withFilters,
  type InboxFilters, type SortMode, type Tab,
} from "./view-query";
import { triageAction } from "./triage-keys";
import { useDeleteItems } from "@/components/useDeleteItems";
import css from "./inbox.module.css";

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
  // One-line preview under the title: AI summary when triage produced one,
  // else a body snippet (or null for title-only submissions).
  preview: string | null;
  // Lowercased, whitespace-collapsed blob of everything searchable about the
  // item — fields, people, initiative, and every comment/reply body. Built
  // server-side (loadItems), matched by the fuzzy search box, never displayed.
  searchText: string;
  type: string;
  status: string;
  // Inbound provenance (Autopilot): the connector this item came from (gong,
  // zendesk, …) or null for native widget/manual/API items, plus a deep-link
  // back to the source call/ticket.
  source: string | null;
  sourceUrl: string | null;
  // Auto-categorize tags applied on ingest (or by hand), shown as inbox chips.
  tags: string[];
  assigneeId: string | null;
  createdAtIso: string;
  accountId: string;
  accountName: string;
  // Revenue priority: ARR summed over the distinct accounts asking (this item +
  // its merged duplicates), in cents, and how many that is. The dollar figure
  // is the visible unit; lib/priority derives the composite sort from it.
  arrAtStakeCents: number;
  reachAccounts: number;
  submitterName: string;
  assigneeInitials: string | null;
  replyCount: number;
  // Loop turn inputs: who moved last (lib/loop-sql lastTurnSideSql: a reply, a
  // delivered status email, Set aside) + when the latest non-internal reply landed.
  lastReplySide: ReplySide | null;
  lastExternalReplyAtIso: string | null;
  vendorReplied: boolean;
  // "Eng done, not told" inputs (lib/loop engDoneUntold): the linked tracker
  // ticket's state and last sync, and the newest notification the customer got.
  externalProvider: string | null;
  externalStatus: string | null;
  externalSyncedAtIso: string | null;
  lastNotifiedAtIso: string | null;
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

// The "any" option of each filter dropdown (no filter, so nothing in the URL).
const ANY = "__any";

const STATUS_FILTER_OPTIONS = Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }));
const TYPE_FILTER_OPTIONS = [
  { value: "bug", label: "Bug" },
  { value: "idea", label: "Idea" },
  { value: "question", label: "Question" },
];

// bulkUpdateStatus's cap: each status runs the item's whole pipeline.
const STATUS_BATCH_MAX = 50;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function ageFrom(iso: string, now: number): string {
  const d = now - new Date(iso).getTime();
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

// The inbox is an obligation queue first: it lands on the loops that are
// waiting on you, with the rest one tab away (Tab in view-query.ts). "eng-done"
// is the view of open loops whose ticket is done while the customer hasn't
// heard (any turn).
//
// Sort order is orthogonal to the loop-turn tabs: the tab picks *which* loops,
// the sort picks *what order*. "newest" keeps the per-tab default (your-turn is
// a longest-waiting-first queue, so it reads "Longest waiting" there);
// "revenue" overrides every tab to rank by the ARR-at-stake composite
// (lib/priority) — Crumb's "revenue is the unit" made the queue order, not
// just a badge.

/**
 * The empty inbox — distinct states for a distinct feeling. Reaching zero on
 * "Your turn" is the vendor's whole payoff (PRODUCT.md: feeling *on top of it*,
 * nothing slipping through), so that one earns a brand moment: the crumb trail
 * lands into place (see .inbox-empty-mark.land in globals.css), once, then
 * rests. Every other empty — a filter miss, an empty Waiting/Closed tab — stays
 * deliberately quiet; a celebration on every blank screen would just be noise.
 */
function InboxEmpty({
  tab, filtersActive, totalRows, onClearFilters,
}: {
  tab: Tab;
  filtersActive: boolean;
  totalRows: number;
  onClearFilters: () => void;
}) {
  // Nothing has ever landed — first run. Calm invite, not a victory lap. The
  // setup checklist above the table (InboxTableTile) carries the next steps.
  if (totalRows === 0) {
    return (
      <div className="inbox-empty" role="cell">
        <span className="inbox-empty-mark"><BrandMark width={38} height={38} /></span>
        <p className="inbox-empty-head">Nothing’s landed yet</p>
        <p className="inbox-empty-sub">
          Work through the setup steps above and feedback lands here, with the
          account, ARR and session already attached.
        </p>
      </div>
    );
  }

  // A filter is hiding everything — quiet, with an escape hatch.
  if (filtersActive) {
    return (
      <div className="inbox-empty quiet" role="cell">
        <p className="inbox-empty-sub">Nothing matches that filter.</p>
        <Btn sm variant="ghost" onClick={onClearFilters}>Clear filters</Btn>
      </div>
    );
  }

  // "Your turn" at zero — the milestone. The trail lands, then rests.
  if (tab === "yours") {
    return (
      <div className="inbox-empty" role="cell">
        <span className="inbox-empty-mark land"><BrandMark width={42} height={42} /></span>
        <p className="inbox-empty-head">You’re all caught up</p>
        <p className="inbox-empty-sub">No loops are waiting on you. Nothing’s slipping through.</p>
      </div>
    );
  }

  // Waiting / Closed / other tabs at zero — accurate and quiet, no fanfare.
  const sub =
    tab === "waiting" ? "Nothing’s waiting on a customer right now."
    : tab === "closed" ? "No closed loops yet. They collect here once an item reaches an outcome."
    : tab === "eng-done" ? "Nothing here right now. Open loops show up here when their linked Linear, Jira or GitHub ticket is done and the customer hasn’t been told since."
    : "Nothing here yet.";
  return (
    <div className="inbox-empty quiet" role="cell">
      <p className="inbox-empty-sub">{sub}</p>
    </div>
  );
}

// How many rows of the active tab to mount at once. The full filtered set stays
// in memory (so tab counts + client-side search are exact); only this many row
// subtrees are built into the DOM, with more revealed on scroll.
const RENDER_WINDOW = 60;

export function InboxTable({
  rows, assignees, meId, canWrite, isAdmin, views, aiEntitled, initiatives, canManageInitiatives, clusterEnabled, emailConfigured,
  nowMs: serverNowMs, aiUpgrade,
}: {
  rows: InboxRow[];
  assignees: Assignee[];
  meId: string;
  canWrite: boolean;
  // Delete and Mark as spam are admin-only.
  isAdmin: boolean;
  // This member's saved views.
  views: SavedView[];
  aiEntitled: boolean;
  initiatives: InitiativeOption[];
  canManageInitiatives: boolean;
  clusterEnabled: boolean;
  // A real email provider is set up (emailConfigured() in lib/email). Without
  // one, the status notes never promise an email.
  emailConfigured: boolean;
  nowMs: number;
  // Cloud Free only: the upgrade notice the locked cluster control reveals
  // (rendered on the server, where the plan + role live). Null hides it.
  aiUpgrade?: ReactNode;
}) {
  const router = useRouter();
  // A single "now" reference, seeded from the server so the first client render
  // (hydration) computes identical timestamps/wait math to the server HTML —
  // anything reading the live clock during render would mismatch and tip React
  // into a full-root client re-render (#422). Bumped once after mount so the
  // values reflect the real client clock (and, for time-of-day, the viewer's
  // local zone) instead of staying pinned to render time.
  const [nowMs, setNowMs] = useState(serverNowMs);
  useEffect(() => { setNowMs(Date.now()); }, []);
  // Warm the thread route on hover/focus so opening from the inbox is as instant
  // as opening from the account page. The inbox click is intercepted for the
  // trail morph, and Next's automatic prefetch is unreliable under a large,
  // churny row list — so prefetch explicitly, once per row.
  const prefetched = useRef<Set<string>>(new Set());
  const warmThread = (shortId: string) => {
    if (prefetched.current.has(shortId)) return;
    prefetched.current.add(shortId);
    router.prefetch(`/thread/${shortId}`);
  };
  const toast = useToast();
  const confirm = useConfirm();
  const searchParams = useSearchParams();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The reason-required status the bulk bar is asking a reason for. It goes
  // with the selection: emptying the selection drops it.
  const [bulkReason, setBulkReason] = useState<string | null>(null);
  if (selected.size === 0 && bulkReason !== null) setBulkReason(null);
  const [pending, startTransition] = useTransition();
  // The view lives in the URL (view-query.ts). The tab, sort and filters are
  // read from it and each change pushes a history entry, so Back undoes it, a
  // refresh keeps your place, and a link (the account page's "View all in
  // inbox", a saved view) opens the same rows. The search is local state for
  // instant typing, mirrored into the URL without a new entry per keystroke.
  const filters = useMemo(() => readFilters(searchParams), [searchParams]);
  const { tab, sort } = filters;
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");

  // Read the live URL, not `filters`: Next applies a push a frame later, and a
  // quick second change must not land on top of a stale first one.
  function setFilters(patch: Partial<InboxFilters>) {
    const now = new URLSearchParams(window.location.search);
    const qs = withFilters(now, { ...readFilters(now), ...patch }).toString();
    if (qs === now.toString()) return;
    window.history.pushState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }
  // Merged duplicates (feature 4) are hidden from the default view — they live
  // under their canonical item. Toggle to audit them.
  const [showMerged, setShowMerged] = useState(false);

  // ── Optimistic status overlay ───────────────────────────────────────────
  // A status write used to wait on the server round-trip + a full router.refresh
  // before anything moved — the inbox stalled mid-triage. Instead we paint the
  // new status the instant it's chosen: an id→status overlay merged over the
  // server rows so the StatusPill, the loop dot, the tab it belongs to and the
  // revenue order all update on the same frame. The server write still runs;
  // when the refreshed rows confirm it, the overlay entry retires itself (the
  // effect below). A failed write clears its entry, snapping the row back.
  const [optStatus, setOptStatus] = useState<Map<string, string>>(new Map());
  // Rows a delete or spam is hiding while its Undo is open (useDeleteItems),
  // by short id. They drop out of every count on the same frame.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const rowsView = useMemo(() => {
    const live = hidden.size === 0 ? rows : rows.filter(r => !hidden.has(r.shortId));
    return optStatus.size === 0 ? live : live.map(r => {
      const status = optStatus.get(r.id);
      if (status === undefined) return r;
      // Setting an item aside is the vendor's move (lastTurnSideSql), so it
      // leaves Your turn on this frame too. Re-saving the same status writes
      // nothing, so that one keeps the server's side.
      return status === "deferred" && r.status !== "deferred"
        ? { ...r, status, lastReplySide: "vendor" as const }
        : { ...r, status };
    });
  }, [rows, optStatus, hidden]);
  // Ids from a write that partly failed. Its result has counts, not ids, so the
  // refreshed server rows decide: these entries drop when the next rows land.
  const unsettled = useRef<Set<string>>(new Set());
  // Retire overlay entries the server has caught up to (keeps the map from
  // growing and lets a later real change through cleanly), plus unsettled ones.
  useEffect(() => {
    const drop = unsettled.current;
    unsettled.current = new Set();
    setOptStatus(prev => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const r of rows) if (next.get(r.id) === r.status) { next.delete(r.id); changed = true; }
      for (const id of drop) if (next.delete(id)) changed = true;
      return changed ? next : prev;
    });
    // A hidden row the server no longer returns is gone for good.
    setHidden(prev => {
      if (prev.size === 0) return prev;
      const present = new Set(rows.map(r => r.shortId));
      const next = new Set([...prev].filter(s => present.has(s)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);
  // Apply (or revert, with status=null) an optimistic status for a set of ids.
  const setOptimisticStatus = (ids: string[], status: string | null) =>
    setOptStatus(prev => {
      const next = new Map(prev);
      for (const id of ids) { if (status === null) next.delete(id); else next.set(id, status); }
      return next;
    });

  // Reply-in-place: which row's drawer is expanded (single-open accordion), plus
  // a per-row draft store so collapsing or peeking away never drops an unsent
  // reply — re-expanding the row restores it.
  const [openReplyId, setOpenReplyId] = useState<string | null>(null);
  // Rows mid-collapse: kept mounted so the drawer can slide *up* before it
  // unmounts, mirroring the slide-down on open (cleared once the exit ends).
  const [closingReply, setClosingReply] = useState<Set<string>>(new Set());
  const drafts = useRef<Map<string, string>>(new Map());

  const finishClosing = (id: string) =>
    setClosingReply(s => { if (!s.has(id)) return s; const n = new Set(s); n.delete(id); return n; });
  // Mark a row as leaving (keeps it mounted for the slide-up) and schedule its
  // unmount once the animation has played. Owning the timer here — tied to the
  // collapse action — is more reliable than a child effect calling back up.
  const markClosing = (id: string) => {
    setClosingReply(s => { const n = new Set(s); n.add(id); return n; });
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => finishClosing(id), reduced ? 0 : DRAWER_EXIT_MS);
  };

  function openReply(id: string) {
    finishClosing(id);                                                // reopening: cancel its exit
    if (openReplyId && openReplyId !== id) markClosing(openReplyId);  // slide the previous one out
    setOpenReplyId(id);
  }
  function collapseReply(id: string) {
    // Leaving the drawer from inside it (Esc, Collapse, a send that closes the
    // loop) puts focus back on its row, so keyboard triage carries on there.
    const drawer = rowEls.current.get(id)?.nextElementSibling;
    if (drawer?.classList.contains("reply-drawer") && drawer.contains(document.activeElement)) {
      rowEls.current.get(id)?.querySelector<HTMLElement>(".row-link")?.focus({ preventScroll: true });
    }
    if (openReplyId === id) setOpenReplyId(null);
    markClosing(id);
  }
  // Below ~640px the dense inbox already scrolls horizontally; an inline composer
  // there would be cramped, so the Reply affordance opens the full thread instead.
  const [isPhone, setIsPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const sync = () => setIsPhone(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  function toggleReply(it: InboxRow) {
    if (isPhone) { router.push(`/thread/${it.shortId}`); return; }
    if (openReplyId === it.id) collapseReply(it.id);
    else openReply(it.id);
  }

  // The search goes into the URL as you type, replacing the current entry (no
  // server round-trip, no history step per keystroke). Only `q` is touched, so
  // compose=1 stays until the Compose panel takes it. Passing null state lets
  // Next adopt the URL, so a later router.refresh() doesn't put the old one back.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = query.trim();
    if ((params.get("q") ?? "") === q) return;
    if (q) params.set("q", q);
    else params.delete("q");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [query]);
  // Back and Forward bring their entry's search back with them.
  useEffect(() => {
    const onPop = () => setQuery(new URLSearchParams(window.location.search).get("q") ?? "");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Tab counts respect the merged toggle so numbers match what each tab shows
  // (otherwise every merged duplicate would inflate "Closed").
  const baseRows = useMemo(
    () => (showMerged ? rowsView : rowsView.filter(r => r.mergedIntoId === null)),
    [rowsView, showMerged],
  );

  // Revenue priority, computed once per row. `now` is captured once so a row's
  // wait term is stable across this render. InboxRow structurally satisfies
  // PriorityInput, so the row passes straight through.
  const priorityById = useMemo(() => {
    const m = new Map<string, Priority>();
    for (const r of rowsView) m.set(r.id, priority(r, nowMs));
    return m;
  }, [rowsView, nowMs]);

  // Meter scale: every magnitude bar is sized against the single largest
  // ARR-at-stake in the workspace, so the same item reads the same width in
  // every tab (the reference never shifts as you filter). `|| 1` avoids /0.
  const maxArrAtStake = useMemo(
    () => rowsView.reduce((n, r) => Math.max(n, r.arrAtStakeCents), 0) || 1,
    [rowsView],
  );

  // The filters + search narrow the whole table BEFORE the tabs bucket it, so
  // the tab counts answer "of what I'm looking at, whose turn is it?" instead
  // of quietly reporting the unfiltered workspace.
  const scopedRows = useMemo(() => {
    // Fuzzy, multi-term search across the whole item — title, body, account,
    // people, initiative, status, and every comment — with typo tolerance
    // (lib/fuzzy). Terms split once here, not per row.
    const terms = splitTerms(query);
    return baseRows.filter(r =>
      matchesFilters(r, filters, meId) && (terms.length === 0 || matchesTerms(terms, r.searchText)));
  }, [baseRows, query, filters, meId]);

  const turnCounts = useMemo(() => {
    const counts = { yours: 0, waiting: 0, closed: 0 };
    for (const r of scopedRows) counts[loopTurn(r)] += 1;
    return counts;
  }, [scopedRows]);
  const mineCount = useMemo(() => scopedRows.filter(r => inTab(r, "mine", meId)).length, [scopedRows, meId]);
  const engDoneCount = useMemo(() => scopedRows.filter(engDoneUntold).length, [scopedRows]);
  const mergedTotal = useMemo(() => rowsView.filter(r => r.mergedIntoId !== null).length, [rowsView]);
  // Every account with feedback, for the account filter.
  const accountOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const r of rows) byId.set(r.accountId, r.accountName);
    return [...byId].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);
  // The Eng done view only means something once a ticket is linked somewhere
  // (or someone lands on it from a saved URL).
  const showEngDone = useMemo(() => tab === "eng-done" || rows.some(r => r.externalProvider !== null), [rows, tab]);

  // Tab bucketing on top of the scoped set. Client-side so the UI is instant;
  // bulk ops below operate on the filtered visible set.
  const visibleRows = useMemo(() => {
    const filtered = scopedRows.filter(r => inTab(r, tab, meId));
    // "By revenue" is an explicit choice that overrides every tab's default
    // order: rank by the ARR-at-stake composite (revenue-dominant, ties broken
    // by reach/severity/wait, then newest).
    if (sort === "revenue") {
      return [...filtered].sort((a, b) =>
        byPriorityDesc(
          { ...priorityById.get(a.id)!, createdAtIso: a.createdAtIso },
          { ...priorityById.get(b.id)!, createdAtIso: b.createdAtIso },
        ),
      );
    }
    // Newest sort: "Your turn" is a queue (longest-waiting loop first); other
    // tabs keep the newest-first order from the server.
    if (tab === "yours") {
      return [...filtered].sort((a, b) => waitingSince(a).localeCompare(waitingSince(b)));
    }
    return filtered;
  }, [scopedRows, tab, meId, sort, priorityById]);

  // ── Windowed rendering ───────────────────────────────────────────────────
  // Mount only a slice of the active tab into the DOM and grow it as the user
  // scrolls. visibleRows (the full filtered set) still drives counts, select-all
  // and search; this only bounds how many row subtrees React builds — which is
  // what made a big inbox expensive to first-render (and to recover if hydration
  // ever bailed to a client re-render).
  const [renderCount, setRenderCount] = useState(RENDER_WINDOW);
  // Snap back to the top window when the user changes what they're looking at,
  // so a fresh view always starts at row one. Reset during render (React's
  // sanctioned pattern) rather than in an effect, so we never paint a frame of
  // the previous, larger window against the newly-chosen view.
  const filterKey = `${JSON.stringify(filters)} ${query}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  // The row the keyboard last stood on (j/k or focus), and its last index, so
  // the row that takes its place can take the cursor when it leaves the view.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const cursorAt = useRef(0);
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey);
    setRenderCount(RENDER_WINDOW);
    // A new view starts the keyboard at the top, and keeps only the selected
    // rows it still shows, so a bulk action never reaches rows you can't see.
    setCursorId(null);
    setSelected(prev => {
      if (prev.size === 0) return prev;
      const shown = new Set(visibleRows.map(r => r.id));
      const next = new Set([...prev].filter(id => shown.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }
  const renderedRows = renderCount >= visibleRows.length ? visibleRows : visibleRows.slice(0, renderCount);
  const hasMoreRows = visibleRows.length > renderedRows.length;
  const moreSentinel = useRef<HTMLDivElement | null>(null);
  // Auto-reveal: grow the window when the sentinel comes within reach. Rebuilt on
  // each growth so that if it's still in view after a batch, it fires again and
  // keeps filling until pushed out of range. The "Show more" button inside is a
  // real click target too, so reveal works for keyboard users and without IO.
  useEffect(() => {
    if (!hasMoreRows) return;
    const el = moreSentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) setRenderCount(c => c + RENDER_WINDOW); },
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMoreRows, renderCount, visibleRows]);

  // ── FLIP reorder ─────────────────────────────────────────────────────────
  // When the visible order changes — a sort flip, a tab switch, an optimistic
  // status that re-buckets a row — the rows glide to their new positions instead
  // of snapping. Classic FLIP: hold each row's last resting top, measure the new
  // one after layout, play the inverse with the app's confident expo ease. Only
  // on-screen rows animate (off-screen deltas aren't seen, and content-visibility
  // may have skipped their layout); reduced motion opts out entirely.
  const rowEls = useRef<Map<string, HTMLElement>>(new Map());
  const prevTops = useRef<Map<string, number>>(new Map());
  const setRowEl = (id: string) => (el: HTMLElement | null) => {
    if (el) rowEls.current.set(id, el);
    else rowEls.current.delete(id);
  };
  useLayoutEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const vh = window.innerHeight;
    const nextTops = new Map<string, number>();
    for (const [id, el] of rowEls.current) {
      const top = el.getBoundingClientRect().top;
      nextTops.set(id, top);
      if (reduced) continue;
      const prev = prevTops.current.get(id);
      if (prev === undefined) continue;            // a freshly entered row — no morph
      const dy = prev - top;
      if (Math.abs(dy) < 1 || top < -80 || top > vh + 80) continue;
      el.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
        { duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
    prevTops.current = nextTops;
  }, [visibleRows]);

  // "Select all" takes the rows on the page first. The bulk bar then offers
  // the whole view, with its real count, as an explicit second step.
  const pageSelected = renderedRows.length > 0 && renderedRows.every(r => selected.has(r.id));
  const someSelected = selected.size > 0 && !pageSelected;
  const filtersActive = query.trim() !== "" || filters.status !== null || filters.type !== null
    || filters.assignee !== null || filters.account !== null || filters.initiative !== null;

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(prev => (pageSelected ? new Set() : new Set([...prev, ...renderedRows.map(r => r.id)])));
  }

  function selectAllInView() {
    setSelected(new Set(visibleRows.map(r => r.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function clearFilters() {
    setQuery("");
    setFilters({ status: null, type: null, assignee: null, account: null, initiative: null });
  }

  // ── Saved views: the current filters + search under a name, per member. ──
  const currentView = useMemo(() => {
    const p = withFilters(new URLSearchParams(), filters);
    if (query.trim()) p.set("q", query.trim());
    return viewQuery(p);
  }, [filters, query]);
  const activeView = views.find(v => v.query === currentView) ?? null;
  const [namingView, setNamingView] = useState(false);
  const [viewName, setViewName] = useState("");
  const viewTools = useRef<HTMLDivElement>(null);

  // Closing the name form puts focus on the button that takes its place (Save
  // view, which turns into Delete view in place once the saved view arrives).
  function closeNaming() {
    setNamingView(false);
    requestAnimationFrame(() => (viewTools.current?.lastElementChild as HTMLElement | null)?.focus());
  }

  function openView(id: string) {
    const v = views.find(x => x.id === id);
    if (!v || v.query === currentView) return;
    setQuery(new URLSearchParams(v.query).get("q") ?? "");
    window.history.pushState(null, "", `${window.location.pathname}?${v.query}`);
  }

  function saveView() {
    const name = viewName.trim();
    if (!name) return;
    startTransition(async () => {
      const r = await saveInboxView(name, currentView);
      if (!r.ok) { toast.show({ message: errorMessage(r.error), tone: "error" }); return; }
      closeNaming();
      setViewName("");
      toast.show({ message: `Saved the view “${r.view.name}”.` });
    });
  }

  async function removeView(v: SavedView) {
    const ok = await confirm({
      title: `Delete the view “${v.name}”?`,
      body: "Only the saved view goes. The feedback in it stays as it is.",
      confirmLabel: "Delete view",
      destructive: true,
    });
    if (!ok) return;
    startTransition(async () => {
      const r = await deleteInboxView(v.id);
      toast.show(r.ok ? { message: `Deleted the view “${v.name}”.` } : { message: errorMessage(r.error), tone: "error" });
    });
  }

  // ── Delete / Mark as spam (admins): rows hide at once, Undo brings them
  //    back, and nothing is removed until the Undo window closes. ──
  // The commit's revalidation brings the refreshed rows (no refresh here),
  // and the effect on `rows` then forgets the hidden ids.
  const deleteItems = useDeleteItems({
    onHidden: shortIds => {
      // Focus was in a hidden row's menu or in the bulk bar, which goes with
      // the selection: the cursor takes the first hidden row's place, so the
      // row after it (or the list) gets focus, not the page (effect below).
      const at = visibleRows.findIndex(r => shortIds.includes(r.shortId));
      if (at >= 0) { cursorAt.current = at; setCursorId(visibleRows[at]!.id); }
      setHidden(prev => new Set([...prev, ...shortIds]));
      const gone = new Set(rows.filter(r => shortIds.includes(r.shortId)).map(r => r.id));
      setSelected(prev => {
        const next = new Set([...prev].filter(id => !gone.has(id)));
        return next.size === prev.size ? prev : next;
      });
    },
    onRestored: shortIds => setHidden(prev => new Set([...prev].filter(s => !shortIds.includes(s)))),
  });

  function removeSelected(mode: "delete" | "spam") {
    deleteItems(rows.filter(r => selected.has(r.id)).map(r => ({ shortId: r.shortId, title: r.title })), mode);
  }

  // ── Keyboard triage (triage-keys.ts): j/k walk the rows by focusing each
  //    title link (the row's one tab stop, so Enter opens it natively); r, s,
  //    a and x act on the row that has focus; ? lists them all. ──
  const [showKeys, setShowKeys] = useState(false);
  const closeKeys = useCallback(() => setShowKeys(false), []);
  const focusPending = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  function focusRow(id: string) {
    const el = rowEls.current.get(id);
    if (!el) { focusPending.current = true; return; } // not rendered yet: after the next render
    el.querySelector<HTMLElement>(".row-link")?.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  }

  // The row holding focus, if any.
  function focusedRow(): InboxRow | undefined {
    const id = (document.activeElement as HTMLElement | null)?.closest?.(".inbox-row")?.getAttribute("data-row-id");
    return id ? visibleRows.find(r => r.id === id) : undefined;
  }

  function moveCursor(step: 1 | -1) {
    if (visibleRows.length === 0) return;
    const focused = focusedRow();
    const from = focused?.id ?? cursorId;
    const at = from ? visibleRows.findIndex(r => r.id === from) : -1;
    // From outside the rows, the first key lands back on the remembered row.
    const next = at < 0 ? 0 : focused ? Math.min(visibleRows.length - 1, Math.max(0, at + step)) : at;
    if (next >= renderedRows.length) setRenderCount(c => c + RENDER_WINDOW);
    const id = visibleRows[next]!.id;
    setCursorId(id);
    focusRow(id);
  }

  // A row the cursor reached before it was rendered gets focus once it is.
  useEffect(() => {
    if (!focusPending.current || !cursorId || !rowEls.current.has(cursorId)) return;
    focusPending.current = false;
    focusRow(cursorId);
  });

  // The cursor row left the view (a status moved it to another tab, a delete
  // hid it): the row that took its place gets the cursor, and the focus too
  // when focus fell to the page with it (the list, when no row is left).
  useEffect(() => {
    if (!cursorId) return;
    const i = visibleRows.findIndex(r => r.id === cursorId);
    if (i >= 0) { cursorAt.current = i; return; }
    const next = visibleRows[Math.min(cursorAt.current, visibleRows.length - 1)];
    setCursorId(next?.id ?? null);
    if (document.activeElement && document.activeElement !== document.body) return;
    if (next) focusRow(next.id);
    else listRef.current?.focus();
  }, [visibleRows, cursorId]);

  function assignToMe(row: InboxRow) {
    if (!canWrite) { toast.show({ message: "Viewers can't modify items.", tone: "error" }); return; }
    if (row.assigneeId === meId) { toast.show({ message: `${row.shortId} is already assigned to you.` }); return; }
    const prev = new Map([[row.id, row.assigneeId]]);
    startTransition(async () => {
      const res = await bulkAssign([row.id], meId);
      if (!res.ok) { toast.show({ message: errorMessage(res.error), tone: "error" }); return; }
      router.refresh();
      toast.show({ message: `${row.shortId} assigned to you.`, action: { label: "Undo", onClick: () => undoAssign(prev) } });
    });
  }

  // Latest-render handler behind one window listener.
  const onTriageKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onTriageKey.current = (e: KeyboardEvent) => {
    const action = triageAction(e);
    // An open modal (a confirm, Compose, the shortcuts list) has the keyboard.
    // The Help panel stays mounted while closed, hidden with aria-hidden.
    if (!action || document.querySelector('[aria-modal="true"]:not([aria-hidden="true"])')) return;
    if (action === "help") { e.preventDefault(); setShowKeys(true); return; }
    if (action === "next" || action === "prev") {
      // Arrows move the cursor only from a focused row; anywhere else they
      // scroll the page as usual. j and k work from anywhere on the page.
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !focusedRow()) return;
      if (visibleRows.length === 0) return;
      e.preventDefault();
      moveCursor(action === "next" ? 1 : -1);
      return;
    }
    const row = focusedRow();
    if (!row) return;
    e.preventDefault();
    const el = rowEls.current.get(row.id);
    if (action === "select") toggle(row.id);
    else if (action === "assign") assignToMe(row);
    else if (action === "menu") el?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click();
    else if (action === "reply") {
      // Already open: into its composer. Otherwise open it (a phone goes to the thread).
      if (openReplyId === row.id) el?.nextElementSibling?.querySelector<HTMLElement>("textarea")?.focus();
      else toggleReply(row);
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => onTriageKey.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // ── Bulk writes: every one confirms what changed (with Undo) or surfaces the
  //    failure, so the inbox's core write path is never silent or one-way. ──

  // Status writes go through the real pipeline (status_events, webhooks, and
  // an email to the customer for outcomes), so a reason comes first where the
  // pipeline needs one, and a bulk move that emails confirms first, plainly.
  function chooseStatus(status: string) {
    if (!status || selected.size === 0) return;
    if (REASON_REQUIRED.has(status)) { setBulkReason(status); return; }
    setBulkReason(null);
    if (!statusEmailsCustomer(status)) { applyStatus(status); return; }
    const label = statusLabel(status);
    void confirm({
      title: `Move ${plural(selected.size, "item")} to ${label}?`,
      body: emailNote(selected.size, emailConfigured),
      confirmLabel: `Move to ${label}`,
    }).then(ok => { if (ok) applyStatus(status); });
  }

  // One status write, with the overlay reconciled to what the server did:
  // nothing written snaps the rows back now; a partial failure lets the
  // refreshed server rows decide (see `unsettled`).
  async function writeStatus(ids: string[], status: string, reason?: string) {
    // This write wins over a drawer move still waiting out its undo window.
    for (const r of rows) if (ids.includes(r.id)) cancelWaitingMove(r.shortId);
    const res = await bulkUpdateStatus(ids, status, reason);
    if (!res.ok) setOptimisticStatus(ids, null);
    else if (res.failed > 0) for (const id of ids) unsettled.current.add(id);
    return res;
  }

  function applyStatus(status: string, reason?: string) {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    // Merged duplicates stay put: they follow the item they were merged into
    // (bulkUpdateStatus skips them), so only the rest are painted and undone.
    const prev = new Map<string, string>();
    for (const r of rows) if (selected.has(r.id) && r.mergedIntoId === null) prev.set(r.id, r.status);
    setOptimisticStatus([...prev.keys()], status);   // paint the move on this frame
    startTransition(async () => {
      const res = await writeStatus(ids, status, reason);
      const outcome = statusToast(res, statusLabel(status));
      // Nothing was written: keep the selection (and an open reason form, with
      // its text) for a retry.
      if (!res.ok) { toast.show(outcome); return; }
      setBulkReason(null);
      clearSelection();
      router.refresh();
      // Undo only when it's clean: no email went out and none would on the way
      // back, so only between the quiet triage statuses (open, review). Undoing
      // anything else would email the customer again or need a reason.
      const undoable = res.failed === 0 && prev.size > 0 && !statusEmailsCustomer(status)
        && [...prev.values()].every(s => s === "open" || s === "review");
      toast.show(undoable ? { ...outcome, action: { label: "Undo", onClick: () => undoStatus(prev) } } : outcome);
    });
  }

  function undoStatus(prev: Map<string, string>) {
    const byStatus = new Map<string, string[]>();
    for (const [id, st] of prev) {
      const arr = byStatus.get(st) ?? [];
      arr.push(id);
      byStatus.set(st, arr);
      setOptimisticStatus([id], st);   // paint the revert immediately too
    }
    startTransition(async () => {
      let err: string | null = null;
      for (const [st, ids] of byStatus) {
        const res = await writeStatus(ids, st);
        if (!res.ok) err ??= res.error;
        else if (res.failed > 0) err ??= res.firstError ?? "";
      }
      router.refresh();
      toast.show(err === null ? { message: "Reverted." } : { message: `Couldn't fully revert. ${errorMessage(err)}`, tone: "error" });
    });
  }

  function applyAssign(value: string) {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    const assigneeId = value === "__unassign" ? null : value;
    const name = assigneeId ? assignees.find(a => a.id === assigneeId)?.name ?? "someone" : null;
    const prev = new Map<string, string | null>();
    for (const r of rows) if (selected.has(r.id)) prev.set(r.id, r.assigneeId);
    startTransition(async () => {
      const res = await bulkAssign(ids, assigneeId);
      if (res.ok) {
        clearSelection();
        router.refresh();
        toast.show({
          message: name ? `${plural(res.affected, "item")} assigned to ${name}.` : `${plural(res.affected, "item")} unassigned.`,
          action: { label: "Undo", onClick: () => undoAssign(prev) },
        });
      } else {
        toast.show({ message: errorMessage(res.error), tone: "error" });
      }
    });
  }

  function undoAssign(prev: Map<string, string | null>) {
    const byAssignee = new Map<string | null, string[]>();
    for (const [id, a] of prev) {
      const arr = byAssignee.get(a) ?? [];
      arr.push(id);
      byAssignee.set(a, arr);
    }
    startTransition(async () => {
      let err: string | null = null;
      for (const [a, ids] of byAssignee) {
        // Putting owners back tells nobody: they had these a moment ago.
        const res = await bulkAssign(ids, a, { notify: false });
        if (!res.ok) err ??= res.error;
      }
      router.refresh();
      toast.show(err === null ? { message: "Reverted." } : { message: `Couldn't fully revert. ${errorMessage(err)}`, tone: "error" });
    });
  }

  function applyInitiative(value: string) {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    const initiativeId = value === "__clear" ? null : value;
    const name = initiativeId ? initiatives.find(i => i.id === initiativeId)?.name ?? "initiative" : null;
    const prev = new Map<string, string | null>();
    for (const r of rows) if (selected.has(r.id)) prev.set(r.id, r.initiativeId);
    startTransition(async () => {
      const res = await bulkSetInitiative(ids, initiativeId);
      if (res.ok) {
        clearSelection();
        router.refresh();
        toast.show({
          message: name ? `${plural(ids.length, "item")} moved to ${name}.` : `${plural(ids.length, "item")} cleared of initiative.`,
          action: { label: "Undo", onClick: () => undoInitiative(prev) },
        });
      } else {
        toast.show({ message: errorMessage(res.error), tone: "error" });
      }
    });
  }

  function undoInitiative(prev: Map<string, string | null>) {
    const byInitiative = new Map<string | null, string[]>();
    for (const [id, init] of prev) {
      const arr = byInitiative.get(init) ?? [];
      arr.push(id);
      byInitiative.set(init, arr);
    }
    startTransition(async () => {
      let err: string | null = null;
      for (const [init, ids] of byInitiative) {
        const res = await bulkSetInitiative(ids, init);
        if (!res.ok) err ??= res.error;
      }
      router.refresh();
      toast.show(err === null ? { message: "Reverted." } : { message: `Couldn't fully revert. ${errorMessage(err)}`, tone: "error" });
    });
  }

  // Locked cluster control (Cloud Free): toggles the upgrade notice.
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  function clusterSelected() {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    startTransition(async () => {
      const res = await clusterItems(ids);
      if (res.ok) {
        clearSelection();
        router.refresh();
        toast.show({ message: res.suggested > 0 ? `Clustered ${plural(res.suggested, "item")} into initiatives.` : "No new clusters found." });
      } else {
        toast.show({ message: errorMessage(res.error), tone: "error" });
      }
    });
  }

  function onAccept(suggestionId: string) {
    startTransition(async () => {
      const r = await acceptSuggestion(suggestionId);
      if (r.ok) router.refresh();
      else toast.show({ message: errorMessage(r.error), tone: "error" });
    });
  }

  function onDismiss(suggestionId: string) {
    startTransition(async () => {
      const r = await dismissSuggestion(suggestionId);
      if (r.ok) router.refresh();
      else toast.show({ message: errorMessage(r.error), tone: "error" });
    });
  }

  function onAcceptTriage(itemId: string) {
    startTransition(async () => {
      const r = await acceptTriageAssignee(itemId);
      if (r.ok) router.refresh();
      else toast.show({ message: errorMessage(r.error), tone: "error" });
    });
  }

  function onDismissTriage(itemId: string) {
    startTransition(async () => {
      const r = await dismissTriage(itemId);
      if (r.ok) router.refresh();
      else toast.show({ message: errorMessage(r.error), tone: "error" });
    });
  }

  return (
    <div className="inbox-board">
      {/* Toolbar lays out as two governed groups: the loop-turn tabs (the
          product's primary scope) lead with search beside them, and the
          secondary tools (sort + merged) cluster after, so on a narrow
          viewport the options wrap as one block to a second line instead of
          scattering. The filters and saved views take the line below, and the
          sort-basis caption gets its own quiet line. The toolbar stays while
          rows are selected, so the view you're acting on stays in sight. */}
      <div className="inbox-toolbar">
        <div className="inbox-toolbar-main">
          <div className="seg" role="tablist" aria-label="Filter by loop turn">
            <button
              role="tab"
              aria-selected={tab === "yours"}
              onClick={() => setFilters({ tab: "yours" })}
              title="Open loops waiting on you: no answer yet, or the customer wrote after your last reply or update"
            >Your turn · {turnCounts.yours}</button>
            <button
              role="tab"
              aria-selected={tab === "waiting"}
              onClick={() => setFilters({ tab: "waiting" })}
              title="You moved last: a reply, a status email the customer got, or Set aside. Waiting on the customer or the fix to ship"
            >Waiting · {turnCounts.waiting}</button>
            <button
              role="tab"
              aria-selected={tab === "closed"}
              onClick={() => setFilters({ tab: "closed" })}
              title="Loops with an outcome: shipped, won't ship, duplicate, or closed by the customer"
            >Closed · {turnCounts.closed}</button>
            <button
              role="tab"
              aria-selected={tab === "mine"}
              onClick={() => setFilters({ tab: "mine" })}
              title="Open loops assigned to you. Closed ones are under Closed"
            >Mine · {mineCount}</button>
            <button role="tab" aria-selected={tab === "all"} onClick={() => setFilters({ tab: "all" })}>All · {scopedRows.length}</button>
            {showEngDone && (
              <button
                role="tab"
                aria-selected={tab === "eng-done"}
                onClick={() => setFilters({ tab: "eng-done" })}
                title="Open loops whose linked Linear, Jira or GitHub ticket is done, and the customer hasn't been told since"
              >Eng done, not told · {engDoneCount}</button>
            )}
          </div>
          <div className="inbox-search">
            <Ic.search style={{ width: 13, height: 13, color: "var(--mute)" }} />
            <input
              className="input search"
              placeholder="Search everything: titles, comments, people…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label="Search feedback, comments, and people"
              style={{ border: 0, padding: 0, background: "transparent" }}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="cmdk-esc"
                style={{ border: 0, background: "transparent", cursor: "pointer", color: "var(--mute)", padding: 2, lineHeight: 0 }}
              >
                <Ic.x style={{ width: 12, height: 12 }} />
              </button>
            )}
          </div>
          <div className="inbox-tools">
            <div className="inbox-sort">
              <span className="text-sm muted">Sort</span>
              <Dropdown
                size="sm"
                ariaLabel="Sort feedback"
                value={sort}
                onChange={v => setFilters({ sort: v as SortMode })}
                buttonStyle={{ minWidth: 124 }}
                options={[
                  // Your turn's default order is the queue: longest wait first.
                  { value: "newest", label: tab === "yours" ? "Longest waiting" : "Newest" },
                  { value: "revenue", label: "By revenue" },
                ]}
              />
            </div>
            {mergedTotal > 0 && (
              <label className="row gap-2 center text-sm muted" style={{ flex: "0 0 auto", cursor: "pointer" }} title="Show duplicates that were merged into another item">
                <input type="checkbox" checked={showMerged} onChange={e => setShowMerged(e.target.checked)} style={{ cursor: "pointer" }} />
                Merged · {mergedTotal}
              </label>
            )}
          </div>
        </div>
        <div className={css.filters}>
          <Dropdown
            size="sm"
            ariaLabel="Filter by status"
            value={filters.status ?? ANY}
            onChange={v => setFilters({ status: v === ANY ? null : v })}
            options={[{ value: ANY, label: "Any status" }, ...STATUS_FILTER_OPTIONS]}
          />
          <Dropdown
            size="sm"
            ariaLabel="Filter by type"
            value={filters.type ?? ANY}
            onChange={v => setFilters({ type: v === ANY ? null : v })}
            options={[{ value: ANY, label: "Any type" }, ...TYPE_FILTER_OPTIONS]}
          />
          <Dropdown
            size="sm"
            ariaLabel="Filter by assignee"
            value={filters.assignee ?? ANY}
            onChange={v => setFilters({ assignee: v === ANY ? null : v })}
            searchable={assignees.length > 8}
            options={[
              { value: ANY, label: "Anyone" },
              { value: ASSIGNEE_ME, label: "Assigned to me" },
              { value: ASSIGNEE_NONE, label: "Unassigned" },
              ...assignees.map(a => ({ value: a.id, label: a.name })),
            ]}
          />
          <Dropdown
            size="sm"
            ariaLabel="Filter by account"
            value={filters.account ?? ANY}
            onChange={v => setFilters({ account: v === ANY ? null : v })}
            searchable={accountOptions.length > 8}
            options={[{ value: ANY, label: "Any account" }, ...accountOptions]}
          />
          {initiatives.length > 0 && (
            <Dropdown
              size="sm"
              ariaLabel="Filter by initiative"
              value={filters.initiative ?? ANY}
              onChange={v => setFilters({ initiative: v === ANY ? null : v })}
              searchable={initiatives.length > 8}
              options={[
                { value: ANY, label: "Any initiative" },
                { value: INITIATIVE_NONE, label: "No initiative" },
                ...initiatives.map(i => ({ value: i.id, label: i.name })),
              ]}
            />
          )}
          {filtersActive && <Btn sm variant="ghost" onClick={clearFilters}>Clear filters</Btn>}
          <div ref={viewTools} className={css.filtersEnd}>
            {views.length > 0 && (
              <Dropdown
                size="sm"
                ariaLabel="Saved views"
                placeholder="Saved views"
                value={activeView?.id ?? null}
                onChange={openView}
                searchable={views.length > 8}
                options={views.map(v => ({ value: v.id, label: v.name }))}
              />
            )}
            {namingView ? (
              <form
                className="row gap-2 center"
                onSubmit={e => { e.preventDefault(); saveView(); }}
              >
                <input
                  className={`input ${css.viewName}`}
                  aria-label="View name"
                  placeholder="Name this view"
                  maxLength={60}
                  autoFocus
                  value={viewName}
                  onChange={e => setViewName(e.target.value)}
                  onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); closeNaming(); } }}
                  disabled={pending}
                />
                <Btn sm variant="primary" type="submit" disabled={pending || !viewName.trim()}>Save</Btn>
                <Btn sm variant="ghost" type="button" onClick={closeNaming} disabled={pending}>Cancel</Btn>
              </form>
            ) : activeView ? (
              <Btn sm variant="ghost" onClick={() => void removeView(activeView)} disabled={pending}>Delete view</Btn>
            ) : currentView ? (
              <Btn sm variant="ghost" icon={<Ic.plus style={{ width: 11, height: 11 }} />} onClick={() => setNamingView(true)}>
                Save view
              </Btn>
            ) : null}
          </div>
        </div>
        {/* When ranking by revenue, name the basis so the order is never a
            black box. The copy degrades on self-host, where AI severity isn't
            part of the composite. Uses --mute (toasted brown 74%, AA on cream),
            not --mute-2 (warm gray ~3.5:1): the caption is load-bearing. */}
        {sort === "revenue" && (
          <p className="inbox-sort-note">
            {aiEntitled
              ? "Ranked by ARR at stake, weighted by reach, severity & wait"
              : "Ranked by ARR at stake, weighted by reach & wait"}
          </p>
        )}
      </div>

      {selected.size > 0 && (
        <div className="inbox-bulkbar row gap-3 center" style={{
          flexWrap: "wrap",
          padding: "10px 14px",
          border: "1px solid var(--text)",
          background: "var(--hover)",
          borderRadius: "var(--r-sm)",
        }}>
          <span className="fw-med">{selected.size} selected</span>
          {pageSelected && selected.size < visibleRows.length && (
            <Btn sm variant="ghost" onClick={selectAllInView} disabled={pending}>
              Select all {visibleRows.length}
            </Btn>
          )}

          {canWrite ? (<>
          <label className="row gap-2 center text-sm" style={{ flex: "0 0 auto" }}>
            <span className="muted">Status</span>
            <Dropdown
              size="sm"
              ariaLabel="Set status"
              placeholder="Set status…"
              value={null}
              disabled={pending || selected.size > STATUS_BATCH_MAX}
              onChange={chooseStatus}
              options={[...VENDOR_STATUS_OPTIONS]}
            />
          </label>
          {selected.size > STATUS_BATCH_MAX && (
            <span className="text-xs muted">Status changes take up to {STATUS_BATCH_MAX} items at a time.</span>
          )}

          <label className="row gap-2 center text-sm" style={{ flex: "0 0 auto" }}>
            <span className="muted">Assign</span>
            <Dropdown
              size="sm"
              ariaLabel="Assign to"
              placeholder="Assign to…"
              value={null}
              disabled={pending}
              searchable={assignees.length > 8}
              onChange={applyAssign}
              options={[
                { value: "__unassign", label: "Unassign" },
                ...assignees.map(a => ({ value: a.id, label: `${a.name} (${a.initials})` })),
              ]}
            />
          </label>

          {canManageInitiatives && (
            <label className="row gap-2 center text-sm" style={{ flex: "0 0 auto" }}>
              <span className="muted">Initiative</span>
              <Dropdown
                size="sm"
                ariaLabel="Set initiative"
                placeholder="Set initiative…"
                value={null}
                disabled={pending}
                searchable={initiatives.length > 8}
                onChange={applyInitiative}
                options={[
                  { value: "__clear", label: "No initiative" },
                  ...initiatives.map(i => ({ value: i.id, label: i.name })),
                ]}
              />
            </label>
          )}
          </>) : (
            <span className="text-sm muted">Viewers can't modify items.</span>
          )}

          {isAdmin && (<>
            <Btn sm variant="ghost" onClick={() => removeSelected("spam")} disabled={pending}>Mark as spam</Btn>
            <Btn sm variant="ghost" onClick={() => removeSelected("delete")} disabled={pending}>Delete</Btn>
          </>)}

          <div style={{ flex: 1 }} />
          <Btn sm variant="ghost" onClick={clearSelection} disabled={pending}>Clear</Btn>

          {/* Full-width last child, so the reason step wraps under the controls. */}
          {bulkReason && (
            <div style={{ flexBasis: "100%" }}>
              <ReasonForm
                status={bulkReason}
                count={selected.size}
                emailConfigured={emailConfigured}
                pending={pending}
                onCancel={() => setBulkReason(null)}
                onSubmit={reason => applyStatus(bulkReason, reason)}
              />
            </div>
          )}
        </div>
      )}

      <Card style={{ padding: 0 }}>
        <div className="inbox-scroll">
          {/* Focusable from script only: where focus goes when a delete
              hides the last row it could land on. */}
          <div ref={listRef} className="list" role="table" aria-label="Feedback inbox" tabIndex={-1}>
            <div className="list-row head inbox-grid" role="row">
              <span role="columnheader" className="inbox-col-check">
                <input
                  type="checkbox"
                  checked={pageSelected}
                  ref={el => { if (el) el.indeterminate = someSelected; }}
                  onChange={toggleAll}
                  aria-label="Select all on this page"
                  style={{ cursor: "pointer" }}
                />
              </span>
              <span role="columnheader" className="inbox-col-id">ID</span>
              <span role="columnheader" className="inbox-col-type">Type</span>
              <span role="columnheader">Title</span>
              <span role="columnheader" className="inbox-col-account">Account · by</span>
              <span role="columnheader" className="inbox-col-initiative">Initiative</span>
              <span role="columnheader">Status</span>
              <span role="columnheader" className="inbox-col-asg">Asg.</span>
              <span role="columnheader">Activity</span>
              <span role="columnheader" aria-label="Actions"></span>
            </div>

            {visibleRows.length === 0 && (
              <div className="list-empty-row" role="row">
                <InboxEmpty
                  tab={tab}
                  filtersActive={filtersActive}
                  totalRows={rows.length}
                  onClearFilters={clearFilters}
                />
              </div>
            )}

            {renderedRows.map(it => {
              const isSel = selected.has(it.id);
              const turn = loopTurn(it);
              const prio = priorityById.get(it.id)!;
              const replyOpen = openReplyId === it.id;
              const replyRendered = replyOpen || closingReply.has(it.id);
              return (
                <Fragment key={it.id}>
                <div
                  ref={setRowEl(it.id)}
                  className={`list-row inbox-grid inbox-row ${css.row} ${isSel ? "selected" : ""} ${replyOpen ? "expanded" : ""}`}
                  role="row"
                  data-row-id={it.id}
                  onFocus={() => setCursorId(it.id)}
                >
                  <span role="cell" className="inbox-col-check row-interactive">
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggle(it.id)}
                      aria-label={`Select ${it.shortId}`}
                      style={{ cursor: "pointer" }}
                    />
                  </span>
                  <span role="cell" className="inbox-col-id text-2xs mono muted">{it.shortId}</span>
                  <span role="cell" className="inbox-col-type"><TypeChip type={it.type as TypeKind} /></span>
                  {/* Title cell: a single navigational link (one tab stop, the
                      title as its accessible name) whose stretched overlay makes
                      the whole row clickable for the mouse. The meta line sits in
                      the same cell, outside the link, so the announcement stays clean. */}
                  <span role="cell" className="inbox-col-title col gap-1" style={{ minWidth: 0 }}>
                    <Link
                      href={`/thread/${it.shortId}`}
                      data-vt-title
                      className="row-link fw-med truncate"
                      style={{ textDecoration: "none", color: "inherit", display: "block", minWidth: 0 }}
                      onPointerEnter={() => warmThread(it.shortId)}
                      onFocus={() => warmThread(it.shortId)}
                      onClick={e => {
                        // Plain left-click lifts the row into the thread via a
                        // View Transition; modified clicks (new tab/window) keep
                        // the native <Link> so we never break "open in new tab".
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                        e.preventDefault();
                        const row = (e.currentTarget as HTMLElement).closest(".inbox-row") as HTMLElement | null;
                        navigateWithTrailMorph(router, `/thread/${it.shortId}`, row);
                      }}
                    >
                      {it.title}
                    </Link>
                    <span className="text-xs muted row gap-2 center" style={{ minWidth: 0 }}>
                      {it.preview && (
                        <span className="truncate" style={{ minWidth: 0, flex: "1 1 auto" }}>{it.preview}</span>
                      )}
                      {/* Signals cluster — right-aligned, fixed; the preview keeps
                          its room and the signals are what drop on a narrow table. */}
                      <span className="row gap-2 center" style={{ flex: "0 0 auto", marginLeft: it.preview ? "auto" : 0 }}>
                        <span data-vt-trail style={{ display: "inline-flex", lineHeight: 0 }}>
                          <LoopBadge closed={trailProgress(it).closed} />
                        </span>
                        {aiEntitled && it.aiSeverity && (
                          <SeverityBadge severity={it.aiSeverity} reason={it.aiTriageReason} />
                        )}
                        {aiEntitled && it.aiSentiment !== null && <SentimentGlyph score={it.aiSentiment} />}
                        {it.replyCount > 0 && (
                          <span className="row gap-1 center">
                            <Ic.chat style={{ width: 10, height: 10 }} />
                            {it.replyCount}
                          </span>
                        )}
                        {it.mergedCount > 0 && (
                          <span className="row gap-1 center" title={`${plural(it.mergedCount, "duplicate")} merged in`}>
                            <Ic.copy style={{ width: 10, height: 10 }} />
                            {it.mergedCount}
                          </span>
                        )}
                        {it.tags.length > 0 && <TagChips tags={it.tags} />}
                        {it.source && CONNECTOR_SOURCES.has(it.source) && (
                          <SourceBadge source={it.source} url={it.sourceUrl} />
                        )}
                      </span>
                    </span>
                  </span>
                  {/* Account cell carries the revenue signal: account + ARR at
                      stake on line 1, submitter + reach on line 2, a tonal
                      magnitude bar underneath. The dollars are the unit; the
                      "why this rank" composite is exposed two ways — the value's
                      aria-label (screen readers) and its title (mouse). */}
                  <span role="cell" className="inbox-col-account col" style={{ gap: 3, minWidth: 0 }}>
                    <span className="row between center gap-2" style={{ minWidth: 0 }}>
                      <span className="fw-med text-sm truncate" style={{ minWidth: 0 }}>{it.accountName}</span>
                      {it.arrAtStakeCents > 0 ? (
                        // role="img" + aria-label so the composite reaches screen
                        // readers, not just mouse hover. We don't make it a tab
                        // stop — the row keeps its single title tab stop by design.
                        <span
                          className="arr-value mono text-2xs"
                          role="img"
                          aria-label={`ARR at stake ${formatArr(it.arrAtStakeCents)}${
                            prio.factors.length > 1
                              ? `. ${prio.factors.slice(1).map(f => (f.delta ? `${f.label} ${f.delta}` : f.label)).join(", ")}`
                              : ""
                          }`}
                          title={`Why this rank: ${prio.summary}`}
                          style={{ flexShrink: 0 }}
                        >
                          {formatArr(it.arrAtStakeCents)}
                        </span>
                      ) : canWrite ? (
                        // Not set ≠ $0: admins/PMs get a quiet path to set it on
                        // the account, where AccountArrEdit already lives. A padded
                        // hit area (negative margin keeps the baseline) so the tap
                        // target isn't a 10px hairline.
                        <Link
                          href={`/accounts/${it.accountId}`}
                          className="row-interactive arr-set text-xs"
                          style={{ flexShrink: 0, padding: "4px 2px", margin: "-4px 0" }}
                        >
                          Set ARR
                        </Link>
                      ) : (
                        <span className="text-2xs muted-2" style={{ flexShrink: 0 }} title="No ARR set on this account">not set</span>
                      )}
                    </span>
                    <span className="row between center gap-2" style={{ minWidth: 0 }}>
                      <span className="text-xs muted truncate" style={{ minWidth: 0 }}>{it.submitterName}</span>
                      {it.reachAccounts > 1 && (
                        <span
                          className="text-2xs muted-2"
                          style={{ flexShrink: 0 }}
                          title={`${it.reachAccounts} accounts asking for this`}
                        >
                          · {it.reachAccounts} accts
                        </span>
                      )}
                    </span>
                    {it.arrAtStakeCents > 0 && (
                      <ArrMeter cents={it.arrAtStakeCents} max={maxArrAtStake} reach={it.reachAccounts} />
                    )}
                  </span>
                  <div role="cell" className="inbox-col-initiative" style={{ minWidth: 0 }}>
                    {it.initiativeId ? (
                      <InitiativeChip
                        initiative={{
                          id: it.initiativeId,
                          shortId: "",
                          name: it.initiativeName ?? "",
                          color: it.initiativeColor,
                          status: "",
                        }}
                      />
                    ) : it.suggestion && canManageInitiatives ? (
                      // maxWidth caps the chip at the 140px cell so the long
                      // initiative name truncates instead of overflowing (and,
                      // being row-interactive/z-2, painting over the Status cell).
                      <span className="row-interactive" style={{ display: "inline-flex", minWidth: 0, maxWidth: "100%" }}>
                        <SuggestionChip
                          suggestion={it.suggestion}
                          onAccept={() => onAccept(it.suggestion!.id)}
                          onDismiss={() => onDismiss(it.suggestion!.id)}
                          disabled={pending}
                        />
                      </span>
                    ) : (
                      <span className="muted-2">—</span>
                    )}
                  </div>
                  <span role="cell" className="inbox-col-status"><StatusPill status={it.status as Status} /></span>
                  <span role="cell" className="inbox-col-asg">
                    {it.assigneeInitials ? (
                      <Avatar size="sm">{it.assigneeInitials}</Avatar>
                    ) : aiEntitled && canWrite && it.aiSuggestedAssignee ? (
                      // Same cap as the SuggestionChip: keep the chip inside its
                      // cell so a long name can't paint over the next column.
                      <span className="row-interactive" style={{ display: "inline-flex", minWidth: 0, maxWidth: "100%" }}>
                        <TriageAssigneeChip
                          assignee={it.aiSuggestedAssignee}
                          reason={it.aiTriageReason}
                          onAccept={() => onAcceptTriage(it.id)}
                          onDismiss={() => onDismissTriage(it.id)}
                          disabled={pending}
                        />
                      </span>
                    ) : (
                      <span className="text-xs muted-2">—</span>
                    )}
                  </span>
                  <span role="cell" className="inbox-col-activity"><LoopAge row={it} turn={turn} nowMs={nowMs} /></span>
                  <span role="cell" className="inbox-col-actions row-interactive">
                    <div className="row gap-1 center" style={{ justifyContent: "flex-end" }}>
                      {/* Reply-in-place: prominent (ember) on "your turn" rows —
                          where replying IS the active path — and a quiet ghost
                          elsewhere. Opens an inline drawer; on phone it routes to
                          the full thread instead (the dense table is cramped). */}
                      <button
                        type="button"
                        className={`reply-btn ${turn === "yours" ? "prominent" : ""} ${replyOpen ? "open" : ""}`}
                        aria-expanded={replyOpen}
                        aria-label={`Reply to ${it.submitterName}`}
                        onClick={() => toggleReply(it)}
                      >
                        <Ic.chat style={{ width: 12, height: 12 }} />
                        <span className="reply-btn-label">Reply</span>
                      </button>
                      <RowActionMenu
                        itemId={it.id}
                        shortId={it.shortId}
                        assigneeId={it.assigneeId}
                        status={it.status}
                        initiativeId={it.initiativeId}
                        assignees={assignees}
                        initiatives={initiatives}
                        canWrite={canWrite}
                        canManageInitiatives={canManageInitiatives}
                        emailConfigured={emailConfigured}
                        merged={it.mergedIntoId !== null}
                        onStatusOptimistic={s => setOptimisticStatus([it.id], s)}  // s===null reverts
                        onDelete={isAdmin ? mode => deleteItems([{ shortId: it.shortId, title: it.title }], mode) : undefined}
                      />
                    </div>
                  </span>
                </div>
                {replyRendered && (
                  <ReplyDrawerMount open={replyOpen}>
                    <RowReplyDrawer
                      row={it}
                      canWrite={canWrite}
                      onCollapse={() => collapseReply(it.id)}
                      draft={drafts.current.get(it.id) ?? ""}
                      onDraftChange={v => { if (v) drafts.current.set(it.id, v); else drafts.current.delete(it.id); }}
                    />
                  </ReplyDrawerMount>
                )}
                </Fragment>
              );
            })}
            {hasMoreRows && (
              <div ref={moreSentinel} className="inbox-more-row" role="row">
                <Btn sm onClick={() => setRenderCount(c => c + RENDER_WINDOW)}>
                  Show more · {renderedRows.length} of {visibleRows.length}
                </Btn>
              </div>
            )}
          </div>
        </div>
      </Card>

      <div className="row between" style={{ flexWrap: "wrap", gap: 12 }}>
        <span className="row gap-3 center" style={{ flexWrap: "wrap" }}>
          <span className="text-sm muted">Showing {visibleRows.length} of {scopedRows.length}</span>
          <button type="button" className={css.hint} onClick={() => setShowKeys(true)}>
            Keyboard shortcuts <kbd className={css.kbd}>?</kbd>
          </button>
        </span>
        {/* Cluster these: AI-only feature. Hidden entirely on self-host. On
            Cloud Free it shows locked and opens the upgrade notice; on a paid
            plan it's enabled when a key is set + at least one initiative
            exists, otherwise the disabled hint nudges setup. */}
        {!aiEntitled && aiUpgrade && canManageInitiatives && (
          <Btn
            sm
            icon={<Ic.lock style={{ width: 11, height: 11 }} />}
            aria-expanded={upgradeOpen}
            onClick={() => setUpgradeOpen(o => !o)}
          >
            Cluster with AI
          </Btn>
        )}
        {upgradeOpen && <div style={{ flexBasis: "100%" }}>{aiUpgrade}</div>}
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
              <Pill ring title={initiatives.length === 0 ? undefined : "The AI provider key isn't set on this deployment."}>
                {initiatives.length === 0 ? "Add an initiative first" : "AI clustering not set up"}
              </Pill>
            )}
          </div>
        )}
      </div>
      {showKeys && <ShortcutsDialog onClose={closeKeys} />}
    </div>
  );
}

// Slide duration for the drawer; the parent schedules the unmount against it so
// the collapse animation plays out before the row leaves the DOM.
const DRAWER_EXIT_MS = 320; // ≥ the CSS grid-template-rows transition (.26s)

// Presentational wrapper: toggles `.open` to drive grid-template-rows 0fr ↔ 1fr.
// On enter it mounts collapsed then flips to 1fr next frame so the rows below
// ease down; on `open` → false it flips back to 0fr (the parent keeps it mounted
// for the slide-up, then unmounts). role row/cell keep the ARIA table valid.
function ReplyDrawerMount({ open, children }: { open: boolean; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (open) {
      // Defer one frame so the browser paints the collapsed (0fr) start state
      // before transitioning to 1fr — otherwise the open would jump.
      const id = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(id);
    }
    setExpanded(false);
  }, [open]);
  return (
    <div className={`reply-drawer ${expanded ? "open" : ""}`} role="row">
      <div className="reply-drawer-inner" role="cell">{children}</div>
    </div>
  );
}

// Brown-tonal magnitude bar for ARR at stake, sized against the workspace's
// largest. Deliberately NOT ember: in the inbox ember is already the loop-state
// accent and the selected-row marker, so a second ember here would be the "two
// embers competing" the One-Trail Rule forbids. Revenue magnitude is structural
// (a tonal bar), not the trail. Decorative for SR — the dollar value carries
// the meaning — so the bar is aria-hidden and the cell text speaks.
function ArrMeter({ cents, max, reach }: { cents: number; max: number; reach: number }) {
  // Floor at 3% so a small-but-real ARR still shows a sliver (matches the
  // accounts table). Scale-X, not width — see globals.css .arr-meter-fill.
  const frac = Math.max(0.03, Math.min(1, cents / max));
  return (
    <span className="arr-meter" aria-hidden title={`${formatArr(cents)} at stake${reach > 1 ? ` across ${reach} accounts` : ""}`}>
      <span className="arr-meter-fill" style={{ transform: `scaleX(${frac})` }} />
    </span>
  );
}

// Loop state, distilled to the one binary that drives action: open (the trail
// is still live — ember ring) or closed (the customer heard the outcome —
// settled, muted). The full four-stage trail lives in the thread header now.
function LoopBadge({ closed }: { closed: boolean }) {
  // .loop-badge crossfades the ring→fill flip (see globals.css) so a loop that
  // closes settles into its dot instead of snapping.
  return (
    <span
      className="loop-badge"
      data-closed={closed}
      role="img"
      aria-label={closed ? "Loop closed" : "Loop open"}
      title={closed ? "Loop closed" : "Loop open"}
    />
  );
}

// Activity cell with loop semantics: a Gmail-style timestamp of the last
// external activity (latest non-internal reply, else creation). On "your turn"
// rows the timestamp warms toward rust as the customer's wait grows — there
// the last activity IS the moment the wait started, so the colored time and
// the urgency basis agree. Plain text (not a link): the row's single title
// link already navigates the whole row.
function LoopAge({ row, turn, nowMs }: { row: InboxRow; turn: LoopTurn; nowMs: number }) {
  // gmailTime formats in the runtime's local zone, so the server (UTC) and the
  // client produce different strings — suppressHydrationWarning lets React keep
  // the server text through hydration instead of erroring, and the post-mount
  // `now` bump repaints it in the viewer's local zone. `nowMs` keeps the
  // today/this-year branch identical across server and first client render.
  const stamp = gmailTime(row.lastExternalReplyAtIso ?? row.createdAtIso, new Date(nowMs));
  if (turn !== "yours") {
    return <span suppressHydrationWarning className="text-xs muted mono" style={{ whiteSpace: "nowrap" }}>{stamp}</span>;
  }
  const since = waitingSince(row);
  const days = waitingDays(since, nowMs);
  const color = days >= 7 ? "var(--rust)" : days >= 3 ? "var(--amber)" : undefined;
  return (
    <span
      suppressHydrationWarning
      className="text-xs muted mono"
      style={{ whiteSpace: "nowrap", ...(color ? { color, fontWeight: 600 } : {}) }}
      title={`Last reply ${stamp} · waiting ${ageFrom(since, nowMs)}`}
    >
      {stamp}
    </span>
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
  const dot = suggestion.initiativeColor ?? "var(--text)";
  const title = suggestion.reason
    ? `${suggestion.reason} · ${Math.round(suggestion.confidence * 100)}% confidence`
    : `${Math.round(suggestion.confidence * 100)}% confidence`;
  return (
    <span className="row gap-2 center" style={{ minWidth: 0 }} title={title}>
      <Ic.sparkle style={{ width: 11, height: 11, color: "var(--mute)", flexShrink: 0 }} />
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
  border: "1px solid var(--hair)",
  borderRadius: 4,
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
  padding: 0,
  flexShrink: 0,
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--rust-deep)",
  high: "var(--rust)",
  medium: "var(--amber)",
  low: "var(--mute)",
};

// Small severity dot + label shown in the inbox row meta line (feature 3).
function SeverityBadge({ severity, reason }: { severity: string; reason: string | null }) {
  const color = SEVERITY_COLOR[severity] ?? "var(--mute)";
  return (
    <span className="row gap-1 center" title={reason ? `AI severity: ${severity} · ${reason}` : `AI severity: ${severity}`}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />
      {severity}
    </span>
  );
}

// Sentiment arrow: down (negative), up (positive), neutral as a flat arrow.
// Carries both shape (arrow direction) and a text aria-label, so meaning never
// rides on color alone.
function SentimentGlyph({ score }: { score: number }) {
  let color = "var(--mute)";
  let label = "neutral";
  let arrow = "→";
  if (score <= -0.2) { color = "var(--rust)"; label = "negative"; arrow = "↓"; }
  else if (score >= 0.2) { color = "var(--green)"; label = "positive"; arrow = "↑"; }
  return (
    <span
      className="row gap-1 center"
      role="img"
      aria-label={`Sentiment: ${label}`}
      style={{ color }}
      title={`AI sentiment: ${label} (${score.toFixed(2)})`}
    >
      <span aria-hidden style={{ fontWeight: 600 }}>{arrow}</span>
    </span>
  );
}

// Inbound feedback connectors (Autopilot). Only these stamp items.source, so the
// badge stays off native widget/manual/API items (source null).
const SOURCE_LABEL: Record<string, string> = {
  gong: "Gong",
  zendesk: "Zendesk",
  intercom: "Intercom",
  freshdesk: "Freshdesk",
  freshchat: "Freshchat",
};
const CONNECTOR_SOURCES = new Set(Object.keys(SOURCE_LABEL));

// Provenance badge: where a pulled item came from. Quiet by design — it's a
// signal, not a headline. Links back to the source call/ticket when we have a
// permalink; the click is isolated from the row's title navigation.
function SourceBadge({ source, url }: { source: string; url: string | null }) {
  const label = SOURCE_LABEL[source] ?? source;
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-2xs muted-2 row-interactive"
        title={`Open in ${label}`}
        style={{ flexShrink: 0, textDecoration: "none" }}
        onClick={e => e.stopPropagation()}
      >
        {label}
      </a>
    );
  }
  return (
    <span className="text-2xs muted-2" title={`Captured from ${label}`} style={{ flexShrink: 0 }}>
      {label}
    </span>
  );
}

// Auto-categorize tags as compact chips. Capped at 2 with a "+N" overflow so the
// dense inbox row stays scannable; the title lists them all.
function TagChips({ tags }: { tags: string[] }) {
  const shown = tags.slice(0, 2);
  const extra = tags.length - shown.length;
  return (
    <span className="row gap-1 center" title={tags.join(", ")} style={{ minWidth: 0 }}>
      {shown.map(t => (
        <span key={t} className="text-2xs muted-2" style={{ flexShrink: 0 }}>#{t}</span>
      ))}
      {extra > 0 && <span className="text-2xs muted-2" style={{ flexShrink: 0 }}>+{extra}</span>}
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
  border: "1px solid var(--hair)",
  borderRadius: 4,
  background: "var(--surface)",
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
