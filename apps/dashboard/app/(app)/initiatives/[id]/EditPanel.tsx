"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic, Switch } from "@crumb/ui";
import type { Announce } from "@/lib/changelog";
import { AnnouncePrompt } from "@/app/(app)/changelog/Announce";
import { setInitiativePublic, updateInitiative } from "../actions";
import type { BoardCol } from "../InitiativesBoard";
import { PRESET_COLORS } from "../presetColors";
import { useColumnMove } from "../useColumnMove";

// "Parked" is just a status — selecting it here is the same as the old "Park"
// button (which only set status='parked'), so there's no separate control.
const STATUSES = [
  { value: "open",        label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "shipped",     label: "Shipped" },
  { value: "parked",      label: "Parked" },
];

type Patch = {
  name?: string;
  description?: string | null;
  internalNotes?: string | null;
  status?: string;
  color?: string | null;
  ownerWorkspaceUserId?: string | null;
  trackedEventNames?: string[] | null;
};

function humanError(code: string): string {
  switch (code) {
    case "name_required":        return "Name can't be empty.";
    case "name_too_long":        return "Name is too long.";
    case "description_too_long": return "Description is too long.";
    case "notes_too_long":       return "Internal notes are too long.";
    case "bad_color":            return "That's not a valid color.";
    case "bad_owner":            return "That teammate isn't in this workspace.";
    case "forbidden":            return "Only admins and PMs can edit initiatives.";
    default:                     return "Couldn't save. Try again.";
  }
}

// Mirror of the server-side normalization in updateInitiative: trim, drop
// empties, cap each name + the list, dedupe (event names are case-sensitive).
// Applied client-side so chips display exactly what gets stored.
const EVENT_NAME_MAX = 64;
const EVENT_LIST_MAX = 20;
function normalizeEvents(list: string[]): string[] {
  return Array.from(new Set(
    list.map(s => s.trim()).filter(Boolean).map(s => s.slice(0, EVENT_NAME_MAX)),
  )).slice(0, EVENT_LIST_MAX);
}

export function EditPanel({
  initiative,
  members,
  eventOptions,
  canManage,
}: {
  initiative: {
    id: string;
    name: string;
    description: string | null;
    internalNotes: string | null;
    status: string;
    color: string | null;
    ownerWorkspaceUserId: string | null;
    trackedEventNames: string[] | null;
    roadmapColumn: BoardCol | null;
    isPublic: boolean;
    followers: number;
  };
  members: Array<{ id: string; name: string }>;
  eventOptions: Array<{ name: string; count: number }>;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initiative.name);
  const [description, setDescription] = useState(initiative.description ?? "");
  const [notes, setNotes] = useState(initiative.internalNotes ?? "");
  const [status, setStatus] = useState(initiative.status);
  const [color, setColor] = useState<string | null>(initiative.color);
  const [ownerId, setOwnerId] = useState<string>(initiative.ownerWorkspaceUserId ?? "");
  const [tracked, setTracked] = useState<string[]>(initiative.trackedEventNames ?? []);
  const [eventDraft, setEventDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Set when the initiative just shipped with its changelog entry unsent.
  const [announce, setAnnounce] = useState<Announce | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const [isPublic, setIsPublic] = useState(initiative.isPublic);
  // The board's Now / Next / Later without a drag. Moving a public initiative
  // waits behind Undo before its followers are emailed, as a drop does.
  const column = useColumnMove({
    id: initiative.id,
    column: initiative.roadmapColumn,
    isPublic,
    followers: initiative.followers,
    onSaved: () => setSaved(true),
  });

  if (!canManage) return null;

  if (!editing) {
    return (
      <div className="col gap-2" style={{ alignItems: "flex-end", maxWidth: 560 }}>
        <Btn icon={<Ic.settings style={{ width: 12, height: 12 }} />} onClick={() => setEditing(true)}>
          Edit
        </Btn>
        {/* "Done" right after shipping still leaves the announce prompt up. */}
        {announce && <AnnouncePrompt announce={announce} onClose={() => setAnnounce(null)} />}
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
      if (r.ok) { setSaved(true); if (r.announce) setAnnounce(r.announce); router.refresh(); }
      else setError(humanError(r.error));
    });
  }

  function commitName() {
    const trimmed = name.trim();
    if (!trimmed) { setName(initiative.name); setError("Name can't be empty, so it was reverted."); return; }
    if (trimmed === initiative.name) return;
    persist({ name: trimmed });
  }
  function commitDescription() {
    const next = description.trim() || null;
    if ((next ?? "") === (initiative.description ?? "")) return;
    persist({ description: next });
  }
  function commitNotes() {
    const next = notes.trim() || null;
    if ((next ?? "") === (initiative.internalNotes ?? "")) return;
    persist({ internalNotes: next });
  }
  // Tracked events are managed as chips. Every add/remove normalizes the set
  // and auto-saves, but only when it actually changed (each control sends just
  // its own patch — same idiom as the other fields).
  function saveEvents(next: string[]) {
    const cleaned = normalizeEvents(next);
    const unchanged = cleaned.length === tracked.length && cleaned.every((n, i) => n === tracked[i]);
    if (unchanged) return;
    setTracked(cleaned);
    persist({ trackedEventNames: cleaned.length ? cleaned : null });
  }
  function addEvents(raw: string) {
    // Split on comma so a pasted "a, b, c" becomes three chips.
    const parts = raw.split(",");
    if (!parts.some(p => p.trim())) return;
    saveEvents([...tracked, ...parts]);
  }
  function commitDraft() {
    if (!eventDraft.trim()) { setEventDraft(""); return; }
    addEvents(eventDraft);
    setEventDraft("");
  }
  function pickStatus(v: string) {
    setStatus(v);
    if (v !== "shipped") setAnnounce(null);
    persist({ status: v });
  }
  function pickOwner(v: string) { setOwnerId(v); persist({ ownerWorkspaceUserId: v || null }); }
  function pickColor(c: string) { if (c === color) return; setColor(c); persist({ color: c }); }
  function pickColumn(v: string) { setSaved(false); column.move((v || null) as BoardCol | null); }
  function togglePublic() {
    const next = !isPublic;
    setIsPublic(next);
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const r = await setInitiativePublic(initiative.id, next);
      if (r.ok) { setSaved(true); router.refresh(); }
      else { setIsPublic(!next); setError(humanError(r.error)); }
    });
  }
  const emailsOnMove = isPublic && initiative.followers > 0;

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
        <span className="text-2xs muted">{pending || column.saving ? "Saving…" : saved ? "Saved" : "Auto-saves"}</span>
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
          aria-describedby="ed-desc-help"
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
        />
        <span id="ed-desc-help" className="text-2xs muted">
          Customers see this on the public roadmap when the initiative is public. It also starts the changelog draft when it ships.
        </span>
      </div>
      <div className="col gap-1">
        <label className="eyebrow" htmlFor="ed-notes">Internal notes</label>
        <textarea
          id="ed-notes"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          onBlur={commitNotes}
          rows={3}
          aria-describedby="ed-notes-help"
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
        />
        <span id="ed-notes-help" className="text-2xs muted">Team only. Never shown to customers.</span>
      </div>
      <div className="col gap-1">
        <label className="eyebrow" htmlFor="ed-status">Status</label>
        <select id="ed-status" value={status} onChange={e => pickStatus(e.target.value)} style={inputStyle}>
          {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      {announce && <AnnouncePrompt announce={announce} onClose={() => setAnnounce(null)} />}
      <div className="col gap-1">
        <label className="eyebrow" htmlFor="ed-column">Column</label>
        <select
          id="ed-column"
          value={column.shown ?? ""}
          onChange={e => pickColumn(e.target.value)}
          aria-describedby={emailsOnMove ? "ed-column-help" : undefined}
          style={inputStyle}
        >
          <option value="">Unscheduled</option>
          <option value="now">Now</option>
          <option value="next">Next</option>
          <option value="later">Later</option>
        </select>
        {emailsOnMove && (
          <span id="ed-column-help" className="text-2xs muted">
            Moving it to Now, Next or Later emails its {initiative.followers} {initiative.followers === 1 ? "follower" : "followers"}, after a few seconds to undo.
          </span>
        )}
      </div>
      <div className="col gap-1">
        <span className="eyebrow">Public</span>
        {/* The label names the switch for screen readers. */}
        <label className="row gap-2 center" style={{ alignSelf: "flex-start", cursor: "pointer" }}>
          <Switch on={isPublic} onClick={togglePublic} />
          <span className="text-sm">Show on the customer roadmap</span>
        </label>
        <span className="text-2xs muted">
          {column.shown === null
            ? "Customers only see a public initiative once it's in Now, Next or Later."
            : "Public initiatives show on the roadmap in the widget, where customers can follow them."}
        </span>
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

      <div className="col gap-1">
        <label className="eyebrow" htmlFor="ed-tracked">Tracked usage events</label>
        {tracked.length > 0 && (
          <div className="row gap-1" style={{ flexWrap: "wrap", marginBottom: 2 }}>
            {tracked.map(name => (
              <span
                key={name}
                className="row center gap-1"
                style={{
                  background: "var(--paper)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-sm)",
                  padding: "2px 4px 2px 8px",
                }}
              >
                <span className="mono text-xs">{name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => saveEvents(tracked.filter(n => n !== name))}
                  style={{ background: "none", border: 0, padding: 2, cursor: "pointer", color: "var(--mute)", display: "inline-flex" }}
                >
                  <Ic.x style={{ width: 11, height: 11 }} />
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          id="ed-tracked"
          list="ed-tracked-options"
          value={eventDraft}
          onChange={e => {
            const v = e.target.value;
            // A comma (typed or pasted) commits everything before the last one
            // as chips and keeps the rest as the live draft.
            if (v.includes(",")) {
              const idx = v.lastIndexOf(",");
              addEvents(v.slice(0, idx));
              setEventDraft(v.slice(idx + 1));
            } else {
              setEventDraft(v);
            }
          }}
          onBlur={commitDraft}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); commitDraft(); }
            else if (e.key === "Backspace" && !eventDraft && tracked.length) {
              saveEvents(tracked.slice(0, -1));
            }
          }}
          placeholder={tracked.length >= EVENT_LIST_MAX ? "Max 20 events" : tracked.length ? "Add another…" : "export.csv"}
          disabled={tracked.length >= EVENT_LIST_MAX}
          style={inputStyle}
        />
        <datalist id="ed-tracked-options">
          {eventOptions.filter(o => !tracked.includes(o.name)).map(o => (
            <option key={o.name} value={o.name} label={`${o.count.toLocaleString()}×`} />
          ))}
        </datalist>
        <span className="text-2xs muted">
          {eventOptions.length
            ? "Pick from crumb.track() events seen in the last 90 days, or type a new name. When this ships, the page shows adoption before vs after."
            : "Type a crumb.track() event name, then press Enter or comma to add each. When this ships, the page shows adoption before vs after."}
        </span>
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
