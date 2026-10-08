"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Btn, Ic } from "@crumb/ui";
import { createInitiative } from "./actions";
import { PRESET_COLORS } from "./presetColors";

export function NewInitiativeForm({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>(PRESET_COLORS[0]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const asked = useSearchParams().get("new") === "1";

  // ⌘K's "New initiative" lands on /initiatives?new=1: open the form, then
  // drop the param so a reload or Back doesn't open it again.
  useEffect(() => {
    if (!asked) return;
    if (!disabled) setOpen(true);
    const url = new URL(window.location.href);
    url.searchParams.delete("new");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [asked, disabled]);

  if (!open) {
    return (
      <Btn
        variant="primary"
        icon={<Ic.plus style={{ width: 12, height: 12 }} />}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        New initiative
      </Btn>
    );
  }

  function reset() {
    setName("");
    setDescription("");
    setColor(PRESET_COLORS[0]);
    setError(null);
  }

  function submit() {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    startTransition(async () => {
      const r = await createInitiative({
        name: trimmed,
        description: description.trim() || undefined,
        color,
      });
      if (r.ok) {
        reset();
        setOpen(false);
        router.refresh();
      } else {
        setError(humanError(r.error));
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
        maxWidth: 520,
      }}
    >
      <div className="col gap-1">
        <label className="eyebrow" htmlFor="ini-name">Name</label>
        <input
          id="ini-name"
          className="text-md"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. User Management"
          autoFocus
          maxLength={120}
          style={inputStyle}
        />
      </div>

      <div className="col gap-1">
        <label className="eyebrow" htmlFor="ini-desc">Description</label>
        <textarea
          id="ini-desc"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="What this initiative covers."
          rows={3}
          aria-describedby="ini-desc-help"
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
        />
        <span id="ini-desc-help" className="text-2xs muted">
          Customers see this on the public roadmap when the initiative is public. It also starts the changelog draft when it ships.
        </span>
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
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: c,
                border: color === c ? "2px solid var(--ink)" : "1px solid var(--line)",
                cursor: "pointer",
                padding: 0,
              }}
            />
          ))}
        </div>
      </div>

      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}

      <div className="row gap-2">
        <Btn variant="primary" onClick={submit} disabled={pending}>
          {pending ? "Creating…" : "Create initiative"}
        </Btn>
        <Btn onClick={() => { reset(); setOpen(false); }} disabled={pending}>Cancel</Btn>
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

function humanError(code: string): string {
  switch (code) {
    case "name_required":      return "Name is required.";
    case "name_too_long":      return "Name is too long.";
    case "description_too_long": return "Description is too long.";
    case "bad_color":          return "Pick a valid color.";
    case "forbidden":          return "Only admins and PMs can create initiatives.";
    default:                   return "Something went wrong. Please try again.";
  }
}
