"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic } from "@crumb/ui";
import { updateInitiative } from "../actions";

// "Parked" is just a status — selecting it here is the same as the old "Park"
// button (which only set status='parked'), so there's no separate control.
const STATUSES = [
  { value: "open",        label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "shipped",     label: "Shipped" },
  { value: "parked",      label: "Parked" },
];

const PRESET_COLORS = ["#E27D3A", "#4A2E1F", "#6B8E23", "#3D6FA8", "#A23E3E", "#7A5BA1"];

type Patch = {
  name?: string;
  description?: string | null;
  status?: string;
  color?: string | null;
  ownerWorkspaceUserId?: string | null;
};

function humanError(code: string): string {
  switch (code) {
    case "name_required":        return "Name can't be empty.";
    case "name_too_long":        return "Name is too long.";
    case "description_too_long": return "Description is too long.";
    case "bad_color":            return "That's not a valid color.";
    case "bad_owner":            return "That teammate isn't in this workspace.";
    case "forbidden":            return "Only admins and PMs can edit initiatives.";
    default:                     return "Couldn't save — try again.";
  }
}

export function EditPanel({
  initiative,
  members,
  canManage,
}: {
  initiative: {
    id: string;
    name: string;
    description: string | null;
    status: string;
    color: string | null;
    ownerWorkspaceUserId: string | null;
  };
  members: Array<{ id: string; name: string }>;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initiative.name);
  const [description, setDescription] = useState(initiative.description ?? "");
  const [status, setStatus] = useState(initiative.status);
  const [color, setColor] = useState<string | null>(initiative.color);
  const [ownerId, setOwnerId] = useState<string>(initiative.ownerWorkspaceUserId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (!canManage) return null;

  if (!editing) {
    return (
      <div className="row gap-2">
        <Btn icon={<Ic.settings style={{ width: 12, height: 12 }} />} onClick={() => setEditing(true)}>
          Edit
        </Btn>
      </div>
    );
  }

  // Every field auto-saves — there's no Save/Cancel. Each control sends just
  // its own patch; the header + board refresh to reflect it.
  function persist(patch: Patch) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const r = await updateInitiative(initiative.id, patch);
      if (r.ok) { setSaved(true); router.refresh(); }
      else setError(humanError(r.error));
    });
  }

  function commitName() {
    const trimmed = name.trim();
    if (!trimmed) { setName(initiative.name); setError("Name can't be empty — reverted."); return; }
    if (trimmed === initiative.name) return;
    persist({ name: trimmed });
  }
  function commitDescription() {
    const next = description.trim() || null;
    if ((next ?? "") === (initiative.description ?? "")) return;
    persist({ description: next });
  }
  function pickStatus(v: string) { setStatus(v); persist({ status: v }); }
  function pickOwner(v: string) { setOwnerId(v); persist({ ownerWorkspaceUserId: v || null }); }
  function pickColor(c: string) { if (c === color) return; setColor(c); persist({ color: c }); }

  return (
    <div
      className="col gap-3"
      style={{
        background: "var(--cream)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-md)",
        padding: 16,
        maxWidth: 560,
      }}
    >
      <div className="row between center">
        <span className="eyebrow">Edit initiative</span>
        <span className="text-2xs muted">{pending ? "Saving…" : saved ? "Saved" : "Auto-saves"}</span>
      </div>

      <div className="col gap-1">
        <label className="eyebrow" htmlFor="ed-name">Name</label>
        <input
          id="ed-name"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          maxLength={120}
          style={inputStyle}
        />
      </div>
      <div className="col gap-1">
        <label className="eyebrow" htmlFor="ed-desc">Description</label>
        <textarea
          id="ed-desc"
          value={description}
          onChange={e => setDescription(e.target.value)}
          onBlur={commitDescription}
          rows={3}
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
        />
      </div>
      <div className="col gap-1">
        <label className="eyebrow" htmlFor="ed-status">Status</label>
        <select id="ed-status" value={status} onChange={e => pickStatus(e.target.value)} style={inputStyle}>
          {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      <div className="col gap-1">
        <label className="eyebrow" htmlFor="ed-owner">Owner</label>
        <select id="ed-owner" value={ownerId} onChange={e => pickOwner(e.target.value)} style={inputStyle}>
          <option value="">Unassigned</option>
          {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>
      <div className="col gap-1">
        <span className="eyebrow">Color</span>
        <div className="row gap-2" style={{ flexWrap: "wrap" }}>
          {PRESET_COLORS.map(c => (
            <button
              key={c}
              type="button"
              aria-label={`Pick ${c}`}
              aria-pressed={color === c}
              onClick={() => pickColor(c)}
              style={{
                width: 22, height: 22, borderRadius: "50%", background: c,
                border: color === c ? "2px solid var(--ink)" : "1px solid var(--line)",
                cursor: "pointer", padding: 0,
              }}
            />
          ))}
        </div>
      </div>

      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Btn variant="primary" onClick={() => setEditing(false)} disabled={pending}>Done</Btn>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--paper)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-sm)",
  padding: "8px 10px",
  font: "inherit",
  color: "var(--ink)",
  width: "100%",
};
