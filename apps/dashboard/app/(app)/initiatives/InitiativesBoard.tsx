"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, Switch } from "@crumb/ui";
import { InitiativeStatusPill } from "./InitiativeChip";
import { reorderInitiatives, setInitiativePublic } from "./actions";

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

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

export function InitiativesBoard({ initial, canManage }: { initial: BoardItem[]; canManage: boolean }) {
  const router = useRouter();
  const [items, setItems] = useState<BoardItem[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ col: BoardKey; index: number } | null>(null);

  useEffect(() => { setItems(initial); }, [initial]);

  const run = (optimistic: BoardItem[], fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    setItems(optimistic);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) {
        setError(r.error === "forbidden" ? "Only admins and PMs can edit the board." : (r.error ?? "Something went wrong."));
        setItems(initial);
      } else {
        router.refresh();
      }
    });
  };

  const byCol = (key: BoardKey) =>
    items.filter(i => i.column === colOf(key)).sort((a, b) => a.order - b.order || a.shortId.localeCompare(b.shortId));

  function togglePublic(id: string) {
    const cur = items.find(i => i.id === id);
    if (!cur) return;
    run(items.map(i => (i.id === id ? { ...i, isPublic: !i.isPublic } : i)),
      () => setInitiativePublic(id, !cur.isPublic));
  }

  function handleDrop(targetKey: BoardKey) {
    if (!dragId) return;
    const target = colOf(targetKey);
    const dragged = items.find(i => i.id === dragId);
    if (!dragged) { setDragId(null); setDropTarget(null); return; }

    const colList = items
      .filter(i => i.column === target && i.id !== dragId)
      .sort((a, b) => a.order - b.order || a.shortId.localeCompare(b.shortId));
    let index = dropTarget && dropTarget.col === targetKey ? dropTarget.index : colList.length;
    index = Math.max(0, Math.min(index, colList.length));

    const orderedIds = [...colList.slice(0, index).map(i => i.id), dragged.id, ...colList.slice(index).map(i => i.id)];
    const posIn = new Map(orderedIds.map((id, i) => [id, i]));

    const noop = dragged.column === target && colList.map(i => i.id).join() !== "" &&
      orderedIds.join() === items.filter(i => i.column === target).sort((a, b) => a.order - b.order || a.shortId.localeCompare(b.shortId)).map(i => i.id).join();

    setDragId(null);
    setDropTarget(null);
    if (noop) return;

    run(items.map(i => {
      const p = posIn.get(i.id);
      return p === undefined ? i : { ...i, column: target, order: p };
    }), () => reorderInitiatives(target, orderedIds));
  }

  return (
    <div className="col gap-3">
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
      {items.length === 0 && (
        <Card><div className="card-body"><p className="text-sm muted" style={{ margin: 0 }}>No initiatives yet. Create one above to start grouping feedback and shaping your roadmap.</p></div></Card>
      )}
      {canManage && items.length > 0 && (
        <span className="text-xs muted">Drag cards to schedule and reorder them. Toggle <strong style={{ fontWeight: 600 }}>Public</strong> to show an initiative on the customer roadmap.</span>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, alignItems: "start" }}>
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
                        <Card>
                          <div className="card-body col gap-2" style={{ padding: 12 }}>
                            <div className="row gap-2 center" style={{ minWidth: 0 }}>
                              <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", background: it.color ?? "var(--ink)", flexShrink: 0 }} />
                              <span className="text-sm truncate" style={{ fontWeight: 500, lineHeight: 1.35, flex: 1 }}>{it.name}</span>
                            </div>
                            <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
                              <span className="text-2xs mono muted">{it.shortId}</span>
                              <InitiativeStatusPill status={it.status} />
                            </div>
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
