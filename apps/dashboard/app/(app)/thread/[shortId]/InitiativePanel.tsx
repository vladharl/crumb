"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Btn, Card, CardHead, Ic } from "@crumb/ui";
import { setItemInitiative, createInitiative } from "../../initiatives/actions";
import { InitiativeChip } from "../../initiatives/InitiativeChip";

export type ThreadInitiativeOption = {
  id: string;
  name: string;
  color: string | null;
};

export function InitiativePanel({
  itemShortId,
  current,
  options,
  canManage,
}: {
  itemShortId: string;
  current: ThreadInitiativeOption | null;
  options: ThreadInitiativeOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function pick(initiativeId: string | null) {
    startTransition(async () => {
      setError(null);
      const r = await setItemInitiative(itemShortId, initiativeId);
      if (r.ok) {
        setEditing(false);
        setCreating(false);
        setNewName("");
        router.refresh();
      } else {
        setError(humanError(r.error));
      }
    });
  }

  function createAndPick() {
    const trimmed = newName.trim();
    if (!trimmed) { setError("Name is required."); return; }
    startTransition(async () => {
      setError(null);
      const r = await createInitiative({ name: trimmed });
      if (!r.ok) {
        setError(humanError(r.error));
        return;
      }
      const link = await setItemInitiative(itemShortId, r.id);
      if (link.ok) {
        setEditing(false);
        setCreating(false);
        setNewName("");
        router.refresh();
      } else {
        setError(humanError(link.error));
      }
    });
  }

  return (
    <Card>
      <CardHead title="Initiative" />
      <div className="card-body col gap-3">
        {!editing && (
          <>
            {current ? (
              <div className="row gap-2 center" style={{ justifyContent: "space-between" }}>
                <Link
                  href={`/initiatives/${current.id}`}
                  className="row gap-2 center"
                  style={{ textDecoration: "none", color: "inherit", minWidth: 0, flex: 1 }}
                >
                  <InitiativeChip
                    initiative={{ id: current.id, shortId: "", name: current.name, color: current.color, status: "" }}
                  />
                </Link>
                {canManage && (
                  <button
                    className="link-back"
                    style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
                    onClick={() => setEditing(true)}
                  >
                    Change
                  </button>
                )}
              </div>
            ) : (
              <div className="row gap-2 center" style={{ justifyContent: "space-between" }}>
                <span className="text-sm muted">No initiative set.</span>
                {canManage && (
                  <button
                    className="link-back"
                    style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
                    onClick={() => setEditing(true)}
                  >
                    Set one
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {editing && !creating && (
          <div className="col gap-2">
            <select
              className="input"
              defaultValue={current?.id ?? ""}
              disabled={pending}
              onChange={e => {
                const v = e.target.value;
                if (v === "__none") pick(null);
                else if (v === "__create") setCreating(true);
                else pick(v);
              }}
              style={{ padding: "6px 10px", height: 32 }}
            >
              <option value="" disabled>Pick an initiative…</option>
              <option value="__none">— No initiative —</option>
              {options.map(o => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
              <option value="__create">+ Create new…</option>
            </select>
            <div className="row gap-2">
              <Btn sm onClick={() => setEditing(false)} disabled={pending}>Cancel</Btn>
            </div>
          </div>
        )}

        {editing && creating && (
          <div className="col gap-2">
            <input
              className="input"
              placeholder="e.g. User Management"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              autoFocus
              maxLength={120}
              disabled={pending}
              style={{ padding: "6px 10px", height: 32 }}
            />
            <div className="row gap-2">
              <Btn sm variant="primary" onClick={createAndPick} disabled={pending || !newName.trim()}>
                {pending ? "Creating…" : "Create & set"}
              </Btn>
              <Btn sm onClick={() => { setCreating(false); setNewName(""); }} disabled={pending}>
                <Ic.chevR style={{ width: 10, height: 10, transform: "rotate(180deg)" }} />
                Back
              </Btn>
            </div>
          </div>
        )}

        {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
      </div>
    </Card>
  );
}

function humanError(code: string): string {
  switch (code) {
    case "name_required": return "Name is required.";
    case "forbidden":     return "Only admins and PMs can change initiatives.";
    default:              return "Something went wrong. Please try again.";
  }
}
