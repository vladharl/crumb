import { Pill } from "@crumb/ui";

export type InitiativeChipData = {
  id: string;
  shortId: string;
  name: string;
  color: string | null;
  status: string;
};

export function InitiativeChip({ initiative }: { initiative: InitiativeChipData | null | undefined }) {
  if (!initiative) return <span className="muted-2">—</span>;
  const dotColor = initiative.color ?? "var(--ink)";
  return (
    <span className="row gap-2 center" style={{ minWidth: 0 }}>
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <span className="text-sm truncate" title={initiative.name} style={{ minWidth: 0 }}>
        {initiative.name}
      </span>
    </span>
  );
}

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  shipped: "Shipped",
  parked: "Parked",
};

export function InitiativeStatusPill({ status }: { status: string }) {
  const label = STATUS_LABEL[status] ?? status;
  const fill = status === "open" || status === "in_progress";
  return <Pill ring ringFill={fill}>{label}</Pill>;
}
