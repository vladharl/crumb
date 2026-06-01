"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic, StatusPill, TypeChip } from "@crumb/ui";
import type { Status, TypeKind } from "@crumb/ui";
import { listUnassignedItems, bulkSetInitiative } from "../actions";

type Candidate = {
  id: string;
  shortId: string;
  title: string;
  type: string;
  status: string;
  accountName: string;
};

export function AddItemsButton({ initiativeId }: { initiativeId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function openPanel() {
    setOpen(true);
    setSelected(new Set());
    setQuery("");
    setError(null);
    setLoading(true);
    listUnassignedItems().then(r => {
      setLoading(false);
      if (r.ok) setCandidates(r.items);
      else setError(r.error === "forbidden" ? "Only admins and PMs can group items." : "Couldn't load items.");
    });
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(c =>
      c.title.toLowerCase().includes(q) || c.shortId.toLowerCase().includes(q));
  }, [candidates, query]);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function add() {
    if (selected.size === 0) return;
    setError(null);
    startTransition(async () => {
      const r = await bulkSetInitiative([...selected], initiativeId);
      if (r.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setError(r.error === "forbidden" ? "Only admins and PMs can group items." : "Couldn't add items.");
      }
    });
  }

  return (
    <>
      <Btn sm icon={<Ic.plus style={{ width: 12, height: 12 }} />} onClick={openPanel}>
        Add items
      </Btn>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Add items to this initiative"
          onClick={() => !pending && setOpen(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(28, 24, 21, 0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 55, padding: 24,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="col gap-3"
            style={{
              background: "var(--paper, var(--surface))",
              border: "1px solid var(--line, var(--hair))",
              borderRadius: "var(--r-md)",
              padding: 20,
              width: "min(640px, 100%)",
              maxHeight: "85vh",
              boxShadow: "var(--sh-soft)",
            }}
          >
            <div className="row between center">
              <h3 className="serif" style={{ margin: 0, fontSize: 18 }}>Add items</h3>
              <button
                aria-label="Close"
                onClick={() => setOpen(false)}
                disabled={pending}
                style={{ background: "none", border: 0, padding: 4, cursor: "pointer", color: "var(--mute)" }}
              >
                <Ic.x style={{ width: 14, height: 14 }} />
              </button>
            </div>
            <p className="text-xs muted" style={{ margin: 0 }}>
              Unassigned feedback in your workspace. Selecting items moves them into this initiative.
            </p>

            <div className="row gap-2 center" style={{ position: "relative" }}>
              <Ic.search style={{ width: 13, height: 13, position: "absolute", left: 10, color: "var(--mute)" }} />
              <input
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Filter by title or ID…"
                style={{
                  background: "var(--surface)", border: "1px solid var(--line, var(--hair))",
                  borderRadius: "var(--r-sm)", padding: "8px 10px 8px 30px", font: "inherit",
                  color: "var(--ink)", width: "100%",
                }}
              />
            </div>

            <div className="col" style={{ overflow: "auto", flex: 1, minHeight: 120, border: "1px solid var(--line, var(--hair))", borderRadius: "var(--r-sm)" }}>
              {loading ? (
                <div className="card-body"><span className="text-sm muted">Loading items…</span></div>
              ) : filtered.length === 0 ? (
                <div className="card-body"><span className="text-sm muted">{candidates.length === 0 ? "No unassigned feedback. Every item is already grouped." : "No items match that filter."}</span></div>
              ) : filtered.map(c => {
                const checked = selected.has(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggle(c.id)}
                    aria-pressed={checked}
                    className="row gap-3 center"
                    style={{
                      width: "100%", textAlign: "left", background: checked ? "var(--hover)" : "transparent",
                      border: 0, borderBottom: "1px solid var(--line, var(--hair))", padding: "10px 12px",
                      cursor: "pointer", font: "inherit",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 16, height: 16, flexShrink: 0, borderRadius: 4,
                        border: checked ? "0" : "1.5px solid var(--line)",
                        background: checked ? "var(--text)" : "transparent",
                        display: "grid", placeItems: "center", color: "var(--cream)",
                      }}
                    >
                      {checked && <Ic.check style={{ width: 11, height: 11 }} />}
                    </span>
                    <span className="text-2xs mono muted" style={{ flexShrink: 0, width: 52 }}>{c.shortId}</span>
                    <TypeChip type={c.type as TypeKind} />
                    <span className="fw-med truncate" style={{ flex: 1 }}>{c.title}</span>
                    <span className="text-xs muted truncate" style={{ maxWidth: 110 }}>{c.accountName}</span>
                    <StatusPill status={c.status as Status} />
                  </button>
                );
              })}
            </div>

            {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}

            <div className="row between center">
              <span className="text-xs muted">{selected.size} selected</span>
              <div className="row gap-2">
                <Btn onClick={() => setOpen(false)} disabled={pending}>Cancel</Btn>
                <Btn variant="primary" onClick={add} disabled={pending || selected.size === 0}>
                  {pending ? "Adding…" : `Add ${selected.size || ""} ${selected.size === 1 ? "item" : "items"}`.replace("  ", " ").trim()}
                </Btn>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
