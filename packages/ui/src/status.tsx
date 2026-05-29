import { Ic } from "./icons";

export type Status = "open" | "review" | "planned" | "progress" | "shipped" | "declined" | "deferred" | "duplicate";

export const StatusDot = ({ status }: { status: Status }) => <span className={`status-dot ${status}`} />;

const STATUS_MAP: Record<Status, { l: string; v: string }> = {
  open:      { l: "Open",        v: "ghost"  },
  review:    { l: "In review",   v: "ghost"  },
  planned:   { l: "Planned",     v: "accent" },
  progress:  { l: "In progress", v: "accent" },
  shipped:   { l: "Shipped",     v: "green"  },
  declined:  { l: "Won’t ship",  v: "rust"   },
  deferred:  { l: "Set aside",   v: "amber"  },
  duplicate: { l: "Duplicate",   v: "ghost"  },
};

export const StatusPill = ({ status, withLabel = true }: { status: Status; withLabel?: boolean }) => {
  const s = STATUS_MAP[status] || STATUS_MAP.open;
  return (
    <span className={`pill ${s.v}`} style={{ gap: 7 }}>
      <span className={`status-dot ${status}`} />
      {withLabel && s.l}
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
