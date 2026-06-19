import type { CSSProperties } from "react";
import type { Status } from "@crumb/ui";

export type InitiativeChipData = {
  id: string;
  shortId: string;
  name: string;
  color: string | null;
  status: string;
};

// Initiative color is the one place Crumb admits an arbitrary, user-chosen hue
// (the Two-Tone Rule's sanctioned exception): it's identity, not status. Render
// it as a soft tinted *tag* — a low-alpha wash of the initiative's own hue plus
// a hairline in the same hue — so feedback is scannable by initiative across the
// inbox, account, and thread. The label stays toasted-brown ink (always ≥4.5:1
// on the pale tint, whatever the hue), and the raw color rides the dot only;
// color is never the sole signal — the name is always present.
export function InitiativeChip({ initiative }: { initiative: InitiativeChipData | null | undefined }) {
  if (!initiative) return <span className="muted-2">—</span>;
  const { color, name } = initiative;
  return (
    <span
      className={`init-tag ${color ? "" : "is-neutral"}`}
      style={color ? ({ "--init": color } as CSSProperties) : undefined}
      title={name}
    >
      <span aria-hidden className="init-dot" />
      <span className="init-name">{name}</span>
    </span>
  );
}

// Initiative status, color-coded to the *same* warm semantic vocabulary the
// inbox uses for item status (ember = the active path, green = shipped, amber =
// set aside, ghost = pre-decision) so the roadmap and the inbox speak one
// language. The dot carries the hue and the label the meaning — never color
// alone. Reuses the shared .pill variants + .status-dot classes (no bespoke CSS).
const INIT_STATUS: Record<string, { label: string; variant: string; dot: Status }> = {
  open:        { label: "Open",        variant: "ghost",  dot: "open" },
  in_progress: { label: "In progress", variant: "accent", dot: "progress" },
  shipped:     { label: "Shipped",     variant: "green",  dot: "shipped" },
  parked:      { label: "Parked",      variant: "amber",  dot: "deferred" },
};

export function InitiativeStatusPill({ status }: { status: string }) {
  const s = INIT_STATUS[status] ?? INIT_STATUS.open;
  return (
    <span className={`pill ${s.variant}`} style={{ gap: 7 }}>
      <span className={`status-dot ${s.dot}`} />
      {s.label}
    </span>
  );
}
