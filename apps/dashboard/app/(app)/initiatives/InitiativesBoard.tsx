"use client";

import { useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Ic, SkeletonBlock, Switch } from "@crumb/ui";
import type { Announce } from "@/lib/changelog";
import { AnnouncePrompt } from "@/app/(app)/changelog/Announce";
import { InitiativeStatusPill } from "./InitiativeChip";
import { reorderInitiatives, setInitiativePublic, updateInitiative } from "./actions";
import { MOVE_UNDONE, moveEmailsFollowers, movedMessage, placeInLane } from "./useColumnMove";
import { formatArr } from "@/lib/priority";
import { formatDate } from "@/lib/timefmt";
import { sendAfterDelay, STATUS_EMAIL_DELAY_MS } from "@/components/ReplyComposer";
import { useToast } from "@/components/toast";

export type BoardCol = "now" | "next" | "later";
export type BoardKey = BoardCol | "unscheduled" | "shipped";

export type BoardItem = {
  id: string;
  shortId: string;
  name: string;
  status: string;
  color: string | null;
  column: BoardCol | null;
  order: number;
  isPublic: boolean;
  followers: number;
  // Revenue at stake: ARR summed over the distinct accounts with OPEN feedback
  // in this initiative (the same unit the inbox ranks on), and that account
  // count. Lets the Now/Next/Later board be read by revenue, not gut feel.
  arrAtStakeCents: number;
  accountCount: number;
  ownerName: string | null;
  createdAt: string; // ISO
  shippedAt: string | null; // ISO, while shipped (lib/roadmap shippedAtSql)
};

const COLUMNS: Array<{ key: BoardKey; label: string; hint: string }> = [
  { key: "unscheduled", label: "Unscheduled", hint: "Not on the public roadmap" },
  { key: "now", label: "Now", hint: "Shipping / in progress" },
  { key: "next", label: "Next", hint: "Up soon" },
  { key: "later", label: "Later", hint: "On the horizon" },
  { key: "shipped", label: "Shipped", hint: "Recently shipped first" },
];

const colOf = (key: Exclude<BoardKey, "shipped">): BoardCol | null => (key === "unscheduled" ? null : key);

// Shipped is a status, not a column (lib/roadmap): a shipped card sits in
// Shipped whatever its column, and goes back there if it's un-shipped.
const laneOf = (i: Pick<BoardItem, "status" | "column">): BoardKey =>
  i.status === "shipped" ? "shipped" : i.column ?? "unscheduled";

const sortCards = (a: BoardItem, b: BoardItem) => a.order - b.order || a.shortId.localeCompare(b.shortId);
const newestShipped = (a: BoardItem, b: BoardItem) => (b.shippedAt ?? "").localeCompare(a.shippedAt ?? "") || sortCards(a, b);

// Why Public is locked on an unscheduled card (lib/roadmap onPublicRoadmapSql).
export const PUBLIC_HINT = "Shows on the roadmap once it's in Now, Next or Later, or Shipped.";

// A locked switch is off and disabled, and points at the sentence saying why.
export function PublicSwitch({ on, locked, describedBy, onClick }: {
  on: boolean;
  locked: boolean;
  describedBy: string;
  onClick: () => void;
}) {
  return locked
    ? <Switch on={false} disabled aria-describedby={describedBy} />
    : <Switch on={on} onClick={onClick} />;
}

// Gives each listed card `column`, and its place in the list as its order.
function placed(list: BoardItem[], column: BoardCol | null, orderedIds: string[]): BoardItem[] {
  const pos = new Map(orderedIds.map((id, i) => [id, i]));
  return list.map(i => {
    const p = pos.get(i.id);
    return p === undefined ? i : { ...i, column, order: p };
  });
}

// A public card's move to another roadmap column, waiting behind its Undo toast.
type Held = {
  id: string;
  from: { column: BoardCol | null; order: number };
  column: BoardCol;
  orderedIds: string[];
  toastId: number;
  undo: () => boolean;
  flush: () => void;
};

// The board with the held card back where it was.
const unheld = (list: BoardItem[], h: Held) => list.map(i => (i.id === h.id ? { ...i, ...h.from } : i));

// Read by screen readers, not shown.
const SR_ONLY: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" };

export function InitiativesBoard({ initial, canManage }: { initial: BoardItem[]; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState<BoardItem[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ col: BoardKey; index: number } | null>(null);
  // The ship-and-announce prompt for a card just dropped on Shipped.
  const [announce, setAnnounce] = useState<Announce | null>(null);
  // Where Move up / Move down left a card, for screen readers.
  const [placedSay, setPlacedSay] = useState("");
  const held = useRef<Held | null>(null);
  const server = useRef(initial);
  server.current = initial;

  // The server's board, with a held move still showing until it saves or is undone.
  const serverView = () => {
    const h = held.current;
    return h ? placed(server.current, h.column, h.orderedIds) : server.current;
  };

  useEffect(() => {
    const h = held.current;
    setItems(h ? placed(initial, h.column, h.orderedIds) : initial);
  }, [initial]);

  // Leaving the board saves a held move now, rather than on a timer nothing is
  // left to undo it from.
  useEffect(() => () => held.current?.flush(), []);

  const save = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    startTransition(async () => {
      // A throw (a dropped connection, a stale action after a redeploy) rolls
      // back like a refusal instead of leaving the move on screen.
      const r: { ok: boolean; error?: string } = await fn().catch(() => ({ ok: false }));
      if (!r.ok) {
        setError(r.error === "forbidden" ? "Only admins and PMs can edit the board." : "Something went wrong. The board wasn't changed. Try again.");
        setItems(serverView());
      } else {
        router.refresh();
      }
    });
  };

  const run = (optimistic: BoardItem[], fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    setItems(optimistic);
    save(fn);
  };

  // Drops the held move; true when it stopped in time.
  function dropHeld(): boolean {
    const h = held.current;
    if (!h) return false;
    held.current = null;
    toast.dismiss(h.toastId);
    return h.undo();
  }

  // A public card landing in another roadmap column emails its followers, so
  // that move waits behind an Undo toast before it's saved, like a status email
  // (useStatusMove). Hiding or leaving the page saves it at once.
  function hold(card: BoardItem, column: BoardCol, orderedIds: string[]) {
    const pending = sendAfterDelay(() => {
      // Saving, on time or early: Undo is over.
      const h = held.current;
      held.current = null;
      if (h) toast.dismiss(h.toastId);
      save(() => reorderInitiatives(column, orderedIds));
    }, STATUS_EMAIL_DELAY_MS);
    const toastId = toast.show({
      message: movedMessage(column),
      duration: STATUS_EMAIL_DELAY_MS,
      action: {
        label: "Undo",
        onClick: () => {
          const h = held.current;
          if (h?.toastId !== toastId || !dropHeld()) return;
          setItems(list => unheld(list, h));
          toast.show({ message: MOVE_UNDONE });
        },
      },
    });
    held.current = { id: card.id, from: { column: card.column, order: card.order }, column, orderedIds, toastId, ...pending };
  }

  const byCol = (key: BoardKey) => items.filter(i => laneOf(i) === key).sort(key === "shipped" ? newestShipped : sortCards);

  // Scale every initiative's revenue meter against the board's largest, so the
  // bars are comparable across columns. `|| 1` guards the empty board.
  const maxArr = items.reduce((n, i) => Math.max(n, i.arrAtStakeCents), 0) || 1;

  function togglePublic(id: string) {
    const cur = items.find(i => i.id === id);
    if (!cur) return;
    run(items.map(i => (i.id === id ? { ...i, isPublic: !i.isPublic } : i)),
      () => setInitiativePublic(id, !cur.isPublic));
  }

  // Dropping on Shipped marks the card shipped through the same update as the
  // edit panel's Status, so it drafts the changelog entry and offers to announce it.
  function ship(base: BoardItem[], card: BoardItem) {
    setError(null);
    setItems(base.map(i => (i.id === card.id ? { ...i, status: "shipped", shippedAt: new Date().toISOString() } : i)));
    save(async () => {
      const r = await updateInitiative(card.id, { status: "shipped" });
      if (r.ok && r.announce) setAnnounce(r.announce);
      return r;
    });
  }

  // Moves a card to `slot` of a lane as the board shows it now, the card
  // counted where it sits (null is the end). A drop and Move up / Move down
  // both land here, so they save the same way.
  function moveCard(id: string, targetKey: BoardKey, slot: number | null) {
    // The latest move of a card wins: its held move is dropped and this one
    // starts from where the card was. A held move of another card saves now.
    const h = held.current;
    let base = items;
    let undone = false;
    if (h && h.id === id) {
      if (dropHeld()) { base = unheld(items, h); undone = true; }
    } else h?.flush();
    const dragged = base.find(i => i.id === id);
    if (!dragged) return;

    // Only unshipped cards move, so this always ships one.
    if (targetKey === "shipped") {
      if (undone) toast.show({ message: MOVE_UNDONE });
      ship(base, dragged);
      return;
    }

    const target = colOf(targetKey);
    const inTarget = base.filter(i => laneOf(i) === targetKey).sort(sortCards);
    // The slot counts the lane as shown, a held card where it waits; the other
    // cards keep their order either way.
    const orderedIds = placeInLane(byCol(targetKey).map(i => i.id), id, slot);
    const noop = dragged.column === target && orderedIds.join() === inTarget.map(i => i.id).join();
    // Private and unscheduled cards (and moves within a column) email no one.
    const emails = target !== null && moveEmailsFollowers(dragged, target);

    if (undone && !emails) toast.show({ message: MOVE_UNDONE });
    if (noop) {
      if (undone) setItems(base);
      return;
    }

    setError(null);
    setItems(placed(base, target, orderedIds));
    if (emails && target !== null) hold(dragged, target, orderedIds);
    else save(() => reorderInitiatives(target, orderedIds));
  }

  function handleDrop(targetKey: BoardKey) {
    if (!dragId) return;
    const slot = dropTarget && dropTarget.col === targetKey ? dropTarget.index : null;
    setDragId(null);
    setDropTarget(null);
    moveCard(dragId, targetKey, slot);
  }

  return (
    <div className="col gap-3">
      <span aria-live="polite" style={SR_ONLY}>{placedSay}</span>
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
      {/* Empty board: name the next step (the .inbox-empty styles are the app's empty state). */}
      {items.length === 0 && (
        <Card>
          <div className="inbox-empty quiet">
            <p className="inbox-empty-head">No initiatives yet</p>
            <p className="inbox-empty-sub">
              {canManage ? (
                <>
                  Start one with <strong style={{ fontWeight: 600 }}>New initiative</strong> to group related
                  feedback. Move it into Now, Next or Later, then switch on Public to put it on your roadmap.
                </>
              ) : "Admins and PMs create initiatives here to group related feedback and shape the roadmap."}
            </p>
          </div>
        </Card>
      )}
      {canManage && items.length > 0 && (
        <span className="board-drag-hint text-xs muted">Drag cards to schedule and reorder them, or open one to set its column. Drop one on <strong style={{ fontWeight: 600 }}>Shipped</strong> to mark it shipped and announce it. Toggle <strong style={{ fontWeight: 600 }}>Public</strong> to show an initiative on the customer roadmap. Moving a public card to another column emails its followers, after a few seconds to undo.</span>
      )}
      <div className="board-cols">
        {COLUMNS.map(c => {
          const colItems = byCol(c.key);
          const isColTarget = dropTarget?.col === c.key;
          // Shipped runs full width under the board, its cards on the board's
          // own grid (each padded as a column pads its cards, so they line up).
          // It's ordered by ship date, so its cards don't drag.
          const shipped = c.key === "shipped";
          const movable = canManage && !shipped;
          return (
            <div key={c.key} className="col gap-2" style={shipped ? { gridColumn: "1 / -1" } : undefined}>
              <div className="col gap-0" style={{ padding: "2px 2px 6px" }}>
                <span className="serif text-md">{c.label}</span>
                <span className="text-xs muted">{c.hint}</span>
              </div>
              {shipped && announce && (
                <div style={{ maxWidth: 560 }}>
                  <AnnouncePrompt announce={announce} onClose={() => setAnnounce(null)} />
                </div>
              )}
              <div
                className={shipped ? "board-cols" : "col gap-2"}
                onDragOver={canManage ? (e => { e.preventDefault(); setDropTarget({ col: c.key, index: colItems.length }); }) : undefined}
                onDrop={canManage ? (e => { e.preventDefault(); handleDrop(c.key); }) : undefined}
                style={{
                  minHeight: 80,
                  borderRadius: "var(--r-sm)",
                  padding: shipped ? 0 : 4,
                  transition: "background 120ms, box-shadow 120ms",
                  background: isColTarget ? "rgba(226,125,58,0.06)" : "transparent",
                  boxShadow: isColTarget ? "inset 0 0 0 1.5px var(--accent, #E27D3A)" : "none",
                }}
              >
                {colItems.length === 0 && (
                  <div style={{ gridColumn: "1 / -1", margin: shipped ? 4 : 0, border: "1px dashed var(--line, var(--hair))", borderRadius: "var(--r-sm)", padding: 14, textAlign: "center" }}>
                    <span className="text-xs muted">{canManage ? (shipped ? "Drop a card here to mark it shipped" : "Drop here") : "—"}</span>
                  </div>
                )}
                {colItems.map((it, idx) => {
                  const showLineBefore = movable && isColTarget && dropTarget?.index === idx && dragId !== it.id;
                  // Customers can't see an unscheduled card, so Public is locked
                  // there (one already public can still be switched off).
                  const hidden = laneOf(it) === "unscheduled";
                  const locked = hidden && !it.isPublic;
                  return (
                    <div key={it.id} style={shipped ? { padding: 4 } : undefined}>
                      {showLineBefore && <div style={{ height: 2, background: "var(--accent, #E27D3A)", borderRadius: 2, margin: "2px 0" }} />}
                      <div
                        draggable={movable}
                        onDragStart={movable ? (e => { setDragId(it.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.id); }) : undefined}
                        onDragEnd={movable ? (() => { setDragId(null); setDropTarget(null); }) : undefined}
                        onDragOver={movable ? (e => {
                          e.preventDefault();
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          const before = (e.clientY - rect.top) < rect.height / 2;
                          setDropTarget({ col: c.key, index: idx + (before ? 0 : 1) });
                        }) : undefined}
                        style={{ cursor: movable ? "grab" : undefined, opacity: dragId === it.id ? 0.4 : 1 }}
                      >
                        <Card
                          className="init-card"
                          style={it.color ? ({ "--init": it.color } as CSSProperties) : undefined}
                        >
                          {/* A real link, so keyboard and touch open the card. The
                              link itself isn't draggable, so a pointer drag still
                              picks up the whole card. */}
                          <Link
                            href={`/initiatives/${it.id}`}
                            draggable={false}
                            className="col gap-2"
                            style={{
                              padding: canManage ? "12px 12px 10px" : 12,
                              color: "inherit",
                              textDecoration: "none",
                              borderRadius: "inherit",
                              cursor: movable ? "grab" : undefined,
                            }}
                          >
                            <div className="row gap-2 center" style={{ minWidth: 0 }}>
                              <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", background: it.color ?? "var(--text)", flexShrink: 0 }} />
                              <span className="text-sm truncate" style={{ fontWeight: 500, lineHeight: 1.35, flex: 1 }}>{it.name}</span>
                            </div>
                            <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
                              <span className="text-2xs mono muted">{it.shortId}</span>
                              <InitiativeStatusPill status={it.status} />
                            </div>
                            {/* Revenue at stake: the same "$ + tonal meter" unit
                                as the inbox, rolled up to the initiative. Shown
                                whenever there's open feedback; "ARR not set" when
                                those accounts have no ARR (never a bare "$0"). */}
                            {it.accountCount > 0 && (
                              <div
                                className="col gap-1"
                                title={it.arrAtStakeCents > 0
                                  ? `${formatArr(it.arrAtStakeCents, " ARR at stake")} across ${it.accountCount} ${it.accountCount === 1 ? "account" : "accounts"}`
                                  : `Open feedback from ${it.accountCount} ${it.accountCount === 1 ? "account" : "accounts"}, ARR not set`}
                              >
                                <div className="row between center gap-2">
                                  <span className="text-xs" style={{ color: "var(--text)" }}>
                                    {it.arrAtStakeCents > 0 ? (
                                      <><span className="mono" style={{ fontWeight: 500 }}>{formatArr(it.arrAtStakeCents)}</span> ARR at stake</>
                                    ) : (
                                      <span className="muted">ARR not set</span>
                                    )}
                                  </span>
                                  <span className="text-2xs muted" style={{ flexShrink: 0 }}>
                                    {it.accountCount} {it.accountCount === 1 ? "acct" : "accts"}
                                  </span>
                                </div>
                                {it.arrAtStakeCents > 0 && (
                                  <span className="arr-meter" aria-hidden>
                                    <span
                                      className="arr-meter-fill"
                                      style={{ transform: `scaleX(${Math.max(0.03, Math.min(1, it.arrAtStakeCents / maxArr))})` }}
                                    />
                                  </span>
                                )}
                              </div>
                            )}
                            <div className="row between center" style={{ flexWrap: "wrap", gap: 6 }}>
                              <span className="text-xs muted truncate">{it.ownerName ?? "Unassigned"}</span>
                              <span className="text-2xs muted mono">
                                {it.shippedAt ? `Shipped ${formatDate(it.shippedAt)}` : formatDate(it.createdAt)}
                              </span>
                            </div>
                          </Link>
                          {canManage && (
                            <div
                              className="col gap-1"
                              style={{ margin: "0 12px", padding: "8px 0 12px", borderTop: "1px solid var(--line, var(--hair))" }}
                              draggable={false}
                            >
                              <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
                                {/* The label names the switch for screen readers. */}
                                <label className="row gap-2 center" style={{ cursor: locked ? "default" : "pointer" }}>
                                  <PublicSwitch
                                    on={it.isPublic}
                                    locked={locked}
                                    describedBy={`pub-hint-${it.id}`}
                                    onClick={() => togglePublic(it.id)}
                                  />
                                  <span className="text-xs muted">Public</span>
                                </label>
                                <span className="row gap-1 center" style={{ marginLeft: "auto" }}>
                                  {it.isPublic && it.followers > 0 && (
                                    <span className="text-xs muted" style={{ marginRight: 4 }}>{it.followers} follower{it.followers === 1 ? "" : "s"}</span>
                                  )}
                                  {/* Reordering without a drag, for keyboards and touch.
                                      At an end the button stays focusable and does nothing. */}
                                  {movable && colItems.length > 1 && ([-1, 1] as const).map(step => {
                                    const dir = step < 0 ? "up" : "down";
                                    const end = step < 0 ? idx === 0 : idx === colItems.length - 1;
                                    return (
                                      <button
                                        key={dir}
                                        type="button"
                                        className="btn ghost icon-only"
                                        aria-label={`Move ${it.name} ${dir}`}
                                        aria-disabled={end || undefined}
                                        title={end ? undefined : `Move ${dir}`}
                                        onClick={e => {
                                          if (end) return;
                                          const btn = e.currentTarget;
                                          // Reordering can re-insert this card's node, which drops focus: put it back.
                                          flushSync(() => moveCard(it.id, c.key, step < 0 ? idx - 1 : idx + 2));
                                          btn.focus();
                                          setPlacedSay(`${it.name} is ${step < 0 ? idx : idx + 2} of ${colItems.length} in ${c.label}.`);
                                        }}
                                        style={{ width: 24, height: 24, padding: 0, ...(end ? { opacity: 0.35, pointerEvents: "none" } : null) }}
                                      >
                                        <Ic.chevD aria-hidden style={{ width: 12, height: 12, transform: step < 0 ? "rotate(180deg)" : undefined }} />
                                      </button>
                                    );
                                  })}
                                </span>
                              </div>
                              {hidden && <span id={`pub-hint-${it.id}`} className="text-2xs muted">{PUBLIC_HINT}</span>}
                            </div>
                          )}
                        </Card>
                      </div>
                      {movable && isColTarget && dropTarget?.index === idx + 1 && idx === colItems.length - 1 && dragId !== it.id && (
                        <div style={{ height: 2, background: "var(--accent, #E27D3A)", borderRadius: 2, margin: "2px 0" }} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The board's lanes while it loads: the same grid and headings, a couple of card-sized blocks in each. */
export function InitiativesBoardSkeleton() {
  return (
    <div className="board-cols">
      {COLUMNS.map(c => {
        const shipped = c.key === "shipped";
        return (
          <div key={c.key} className="col gap-2" style={shipped ? { gridColumn: "1 / -1" } : undefined}>
            <div className="col gap-0" style={{ padding: "2px 2px 6px" }}>
              <span className="serif text-md">{c.label}</span>
              <span className="text-xs muted">{c.hint}</span>
            </div>
            <div className={shipped ? "board-cols" : "col gap-2"} style={{ padding: shipped ? 0 : 4 }}>
              {[0, 1].map(i => (
                <div key={i} style={shipped ? { padding: 4 } : undefined}>
                  <SkeletonBlock height={128} style={{ borderRadius: "var(--r-md)" }} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
