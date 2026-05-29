"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic } from "@crumb/ui";
import { updateInitiative, archiveInitiative } from "../actions";

const STATUSES = [
  { value: "open",        label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "shipped",     label: "Shipped" },
  { value: "parked",      label: "Parked" },
];

const PRESET_COLORS = ["#E27D3A", "#4A2E1F", "#6B8E23", "#3D6FA8", "#A23E3E", "#7A5BA1"];

export function EditPanel({
  initiative,
  canManage,
}: {
  initiative: {
    id: string;
    name: string;
    description: string | null;
    status: string;
    color: string | null;
  };
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initiative.name);
  const [description, setDescription] = useState(initiative.description ?? "");
  const [status, setStatus] = useState(initiative.status);
  const [color, setColor] = useState<string | null>(initiative.color);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (!canManage) return null;

  if (!editing) {
    return (
      <div className="row gap-2">
        <Btn
          icon={<Ic.settings style={{ width: 12, height: 12 }} />}
          onClick={() => setEditing(true)}
        >
          Edit
        </Btn>
      </div>
    );
  }

  function save() {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) { setError("Name is required."); return; }
    startTransition(async () => {
      const r = await updateInitiative(initiative.id, {
        name: trimmed,
        description: description.trim() || null,
        status,
        color: color ?? null,
      });
      if (r.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  }

  function archive() {
    if (!confirm("Park this initiative? Items keep their link; it just stops appearing in the active list.")) return;
    startTransition(async () => {
      const r = await archiveInitiative(initiative.id);
      if (r.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  }

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
      <div className="col gap-1">
        <label className="eyebrow" htmlFor="ed-name">Name</label>
        <input
          id="ed-name"
          value={name}
          onChange={e => setName(e.target.value)}
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
          rows={3}
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
        />
      </div>
      <div className="col gap-1">
        <label className="eyebrow" htmlFor="ed-status">Status</label>
        <select
          id="ed-status"
          value={status}
          onChange={e => setStatus(e.target.value)}
          style={inputStyle}
        >
          {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
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
              onClick={() => setColor(c)}
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

      <div className="row gap-2 between">
        <div className="row gap-2">
          <Btn variant="primary" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Btn>
          <Btn onClick={() => setEditing(false)} disabled={pending}>Cancel</Btn>
        </div>
        {initiative.status !== "parked" && (
          <Btn onClick={archive} disabled={pending}>Park</Btn>
        )}
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
