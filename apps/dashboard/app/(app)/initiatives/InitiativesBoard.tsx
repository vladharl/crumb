"use client";

import { useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Card, Switch } from "@crumb/ui";
import { InitiativeStatusPill } from "./InitiativeChip";
import { reorderInitiatives, setInitiativePublic } from "./actions";
import { formatArr } from "@/lib/priority";
import { sendAfterDelay, STATUS_EMAIL_DELAY_MS } from "@/components/ReplyComposer";
import { useToast } from "@/components/toast";

export type BoardCol = "now" | "next" | "later";
export type BoardKey = BoardCol | "unscheduled";

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
};

const COLUMNS: Array<{ key: BoardKey; label: string; hint: string }> = [
  { key: "unscheduled", label: "Unscheduled", hint: "Not on the public roadmap" },
  { key: "now", label: "Now", hint: "Shipping / in progress" },
  { key: "next", label: "Next", hint: "Up soon" },
  { key: "later", label: "Later", hint: "On the horizon" },
];

const colOf = (key: BoardKey): BoardCol | null => (key === "unscheduled" ? null : key);

const sortCards = (a: BoardItem, b: BoardItem) => a.order - b.order || a.shortId.localeCompare(b.shortId);

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

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

export function InitiativesBoard({ initial, canManage }: { initial: BoardItem[]; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState<BoardItem[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ col: BoardKey; index: number } | null>(null);
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
      const r = await fn();
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
    const label = COLUMNS.find(c => c.key === column)?.label ?? column;
    const toastId = toast.show({
      message: `Moved to ${label}. Emailing its followers in ${STATUS_EMAIL_DELAY_MS / 1000} seconds.`,
      duration: STATUS_EMAIL_DELAY_MS,
      action: {
        label: "Undo",
        onClick: () => {
          const h = held.current;
          if (h?.toastId !== toastId || !dropHeld()) return;
          setItems(list => unheld(list, h));
          toast.show({ message: "Undone. Its followers weren't emailed." });
        },
      },
    });
    held.current = { id: card.id, from: { column: card.column, order: card.order }, column, orderedIds, toastId, ...pending };
  }

  const byCol = (key: BoardKey) => items.filter(i => i.column === colOf(key)).sort(sortCards);

  // Scale every initiative's revenue meter against the board's largest, so the
  // bars are comparable across columns. `|| 1` guards the empty board.
  const maxArr = items.reduce((n, i) => Math.max(n, i.arrAtStakeCents), 0) || 1;

  function togglePublic(id: string) {
    const cur = items.find(i => i.id === id);
    if (!cur) return;
    run(items.map(i => (i.id === id ? { ...i, isPublic: !i.isPublic } : i)),
      () => setInitiativePublic(id, !cur.isPublic));
  }

  function handleDrop(targetKey: BoardKey) {
    if (!dragId) return;
    const target = colOf(targetKey);
    // The latest move of a card wins: its held move is dropped and this one
    // starts from where the card was. A held move of another card saves now.
    const h = held.current;
    let base = items;
    let undone = false;
    if (h && h.id === dragId) {
      if (dropHeld()) { base = unheld(items, h); undone = true; }
    } else h?.flush();
    const dragged = base.find(i => i.id === dragId);
    if (!dragged) { setDragId(null); setDropTarget(null); return; }

    const inTarget = base.filter(i => i.column === target).sort(sortCards);
    const colList = inTarget.filter(i => i.id !== dragId);
    let index = dropTarget && dropTarget.col === targetKey ? dropTarget.index : colList.length;
    index = Math.max(0, Math.min(index, colList.length));

    const orderedIds = [...colList.slice(0, index).map(i => i.id), dragged.id, ...colList.slice(index).map(i => i.id)];
    const noop = dragged.column === target && orderedIds.join() === inTarget.map(i => i.id).join();
    // Private and unscheduled cards (and moves within a column) email no one.
    const emails = dragged.isPublic && dragged.followers > 0 && target !== null && target !== dragged.column;

    setDragId(null);
    setDropTarget(null);
    if (undone && !emails) toast.show({ message: "Undone. Its followers weren't emailed." });
    if (noop) {
      if (undone) setItems(base);
      return;
    }

    setError(null);
    setItems(placed(base, target, orderedIds));
    if (emails && target !== null) hold(dragged, target, orderedIds);
    else save(() => reorderInitiatives(target, orderedIds));
  }

  return (
    <div className="col gap-3">
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
                  feedback. Drag it into Now, Next or Later, then switch on Public to put it on your roadmap.
                </>
              ) : "Admins and PMs create initiatives here to group related feedback and shape the roadmap."}
            </p>
          </div>
        </Card>
      )}
      {canManage && items.length > 0 && (
        <span className="board-drag-hint text-xs muted">Drag cards to schedule and reorder them. Toggle <strong style={{ fontWeight: 600 }}>Public</strong> to show an initiative on the customer roadmap. Moving a public card to another column emails its followers, after a few seconds to undo.</span>
      )}
      <div className="board-cols">
        {COLUMNS.map(c => {
          const colItems = byCol(c.key);
          const isColTarget = dropTarget?.col === c.key;
          return (
            <div key={c.key} className="col gap-2">
              <div className="col gap-0" style={{ padding: "2px 2px 6px" }}>
                <span className="serif text-md">{c.label}</span>
                <span className="text-xs muted">{c.hint}</span>
              </div>
              <div
                className="col gap-2"
                onDragOver={canManage ? (e => { e.preventDefault(); setDropTarget({ col: c.key, index: colItems.length }); }) : undefined}
                onDrop={canManage ? (e => { e.preventDefault(); handleDrop(c.key); }) : undefined}
                style={{
                  minHeight: 80,
                  borderRadius: "var(--r-sm)",
                  padding: 4,
                  transition: "background 120ms, box-shadow 120ms",
                  background: isColTarget ? "rgba(226,125,58,0.06)" : "transparent",
                  boxShadow: isColTarget ? "inset 0 0 0 1.5px var(--accent, #E27D3A)" : "none",
                }}
              >
                {colItems.length === 0 && (
                  <div style={{ border: "1px dashed var(--line, var(--hair))", borderRadius: "var(--r-sm)", padding: 14, textAlign: "center" }}>
                    <span className="text-xs muted">{canManage ? "Drop here" : "—"}</span>
                  </div>
                )}
                {colItems.map((it, idx) => {
                  const showLineBefore = canManage && isColTarget && dropTarget?.index === idx && dragId !== it.id;
                  return (
                    <div key={it.id}>
                      {showLineBefore && <div style={{ height: 2, background: "var(--accent, #E27D3A)", borderRadius: 2, margin: "2px 0" }} />}
                      <div
                        draggable={canManage}
                        onDragStart={canManage ? (e => { setDragId(it.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.id); }) : undefined}
                        onDragEnd={canManage ? (() => { setDragId(null); setDropTarget(null); }) : undefined}
                        onDragOver={canManage ? (e => {
                          e.preventDefault();
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          const before = (e.clientY - rect.top) < rect.height / 2;
                          setDropTarget({ col: c.key, index: idx + (before ? 0 : 1) });
                        }) : undefined}
                        onClick={() => router.push(`/initiatives/${it.id}`)}
                        style={{ cursor: canManage ? "grab" : "pointer", opacity: dragId === it.id ? 0.4 : 1 }}
                      >
                        <Card
                          className="init-card"
                          style={it.color ? ({ "--init": it.color } as CSSProperties) : undefined}
                        >
                          <div className="card-body col gap-2" style={{ padding: 12 }}>
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
                                  ? `${formatArr(it.arrAtStakeCents)} of open-feedback ARR across ${it.accountCount} ${it.accountCount === 1 ? "account" : "accounts"}`
                                  : `Open feedback from ${it.accountCount} ${it.accountCount === 1 ? "account" : "accounts"}, no ARR set`}
                              >
                                <div className="row between center gap-2">
                                  <span className="text-xs" style={{ color: "var(--text)" }}>
                                    {it.arrAtStakeCents > 0 ? (
                                      <><span className="mono" style={{ fontWeight: 500 }}>{formatArr(it.arrAtStakeCents)}</span> at stake</>
                                    ) : (
                                      <span className="muted-2">ARR not set</span>
                                    )}
                                  </span>
                                  <span className="text-2xs muted-2" style={{ flexShrink: 0 }}>
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
                              <span className="text-2xs muted mono">{fmtDate(it.createdAt)}</span>
                            </div>
                            {canManage && (
                              <div
                                className="row gap-2 center"
                                style={{ marginTop: 2, paddingTop: 8, borderTop: "1px solid var(--line, var(--hair))" }}
                                onClick={e => e.stopPropagation()}
                                draggable={false}
                              >
                                <Switch on={it.isPublic} onClick={() => togglePublic(it.id)} />
                                <span className="text-xs muted">{it.isPublic ? "Public" : "Private"}</span>
                                {it.isPublic && it.followers > 0 && (
                                  <span className="text-xs muted" style={{ marginLeft: "auto" }}>{it.followers} follower{it.followers === 1 ? "" : "s"}</span>
                                )}
                              </div>
                            )}
                          </div>
                        </Card>
                      </div>
                      {canManage && isColTarget && dropTarget?.index === idx + 1 && idx === colItems.length - 1 && dragId !== it.id && (
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
