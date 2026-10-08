import { Ic } from "./icons";

export type Status = "open" | "review" | "planned" | "progress" | "shipped" | "declined" | "deferred" | "duplicate" | "resolved";

export const StatusDot = ({ status }: { status: Status }) => <span className={`status-dot ${status}`} />;

// Status names and loop sets live here, once. This module has no "use client",
// so server code (SQL helpers, emails, server pages) and client components
// import the same values.
export const STATUS_LABELS: Record<Status, string> = {
  open:      "Open",
  review:    "In review",
  planned:   "Planned",
  progress:  "In progress",
  shipped:   "Shipped",
  declined:  "Won’t ship",
  deferred:  "Set aside",
  duplicate: "Duplicate",
  // Customer-initiated close ("I'm all set"). A closed loop, but distinct from
  // the vendor outcomes above — the customer resolved it themselves.
  resolved:  "Resolved",
};

/** Label for a raw status string (DB rows are plain strings); unknown values pass through. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status as Status] ?? status;
}

export type VendorStatus = Exclude<Status, "resolved">;

// What a vendor may set, in picker order. "resolved" is customer-only (only the
// widget close endpoint sets it), so it never appears in a vendor picker.
export const VENDOR_STATUSES: readonly VendorStatus[] = [
  "open", "review", "planned", "progress", "shipped", "declined", "deferred", "duplicate",
];

export const VENDOR_STATUS_OPTIONS: ReadonlyArray<{ value: VendorStatus; label: string }> =
  VENDOR_STATUSES.map(value => ({ value, label: STATUS_LABELS[value] }));

// The status pipeline won't set these without a reason (it answers
// reason_required). The customer sees the reason in the widget and the email.
export const REASON_REQUIRED: ReadonlySet<string> = new Set<VendorStatus>(["declined", "deferred", "duplicate"]);

// Example reasons for the "say why" boxes, per REASON_REQUIRED status.
export const REASON_PLACEHOLDER: Readonly<Record<string, string>> = {
  declined:  "e.g. We're not building this in v2. The maintenance cost is too high for the use case.",
  deferred:  "e.g. Revisiting in Q3 once the new export pipeline ships.",
  duplicate: "e.g. Tracked under FB-242. Replies there will reach you.",
};

// Closed: the item reached an outcome (shipped/declined/duplicate) or the
// customer closed it from the widget (resolved). Whether the customer was
// actually told is a separate fact (the customer_notifications ledger).
export const CLOSED_STATUSES: ReadonlySet<string> = new Set<Status>(["shipped", "declined", "duplicate", "resolved"]);

// Open: every status that isn't closed, "deferred" included (set aside is a
// pause, not an outcome).
export const OPEN_STATUSES: ReadonlySet<string> = new Set(
  (Object.keys(STATUS_LABELS) as Status[]).filter(s => !CLOSED_STATUSES.has(s)),
);

// Decided: moved past open/review triage. Lights the trail's "decided" dot;
// "resolved" counts, since a customer-closed loop has reached its terminal beat.
export const DECIDED_STATUSES: ReadonlySet<string> = new Set<Status>([
  "planned", "progress", "shipped", "declined", "deferred", "duplicate", "resolved",
]);

// Pill tone per status; the text comes from STATUS_LABELS.
const STATUS_TONE: Record<Status, string> = {
  open:      "ghost",
  review:    "ghost",
  planned:   "accent",
  progress:  "accent",
  shipped:   "green",
  declined:  "rust",
  deferred:  "amber",
  duplicate: "ghost",
  resolved:  "green",
};

export const StatusPill = ({ status, withLabel = true }: { status: Status; withLabel?: boolean }) => {
  const s = STATUS_TONE[status] ? status : "open";
  return (
    <span className={`pill ${STATUS_TONE[s]}`} style={{ gap: 7 }}>
      <span className={`status-dot ${status}`} />
      {withLabel && STATUS_LABELS[s]}
    </span>
  );
};

export type TypeKind = "bug" | "idea" | "question";

const TYPE_MAP: Record<TypeKind, { l: string; ic: (typeof Ic)[keyof typeof Ic] }> = {
  bug:      { l: "Bug",      ic: Ic.bug },
  idea:     { l: "Idea",     ic: Ic.idea },
  question: { l: "Question", ic: Ic.q },
};

export const TypeChip = ({ type }: { type: TypeKind }) => {
  const x = TYPE_MAP[type];
  if (!x) return null;
  const Icon = x.ic;
  return (
    <span className="pill ghost" style={{ gap: 6 }}>
      <Icon style={{ width: 11, height: 11, opacity: 0.7 }} />
      {x.l}
    </span>
  );
};
