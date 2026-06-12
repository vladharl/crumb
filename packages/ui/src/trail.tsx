/**
 * TrailDots — the loop made visible. Four crumbs along an item's trail:
 * heard (it arrived) → answered (a vendor replied) → decided (status moved
 * past triage) → closed (the customer heard the outcome). Lit dots grow,
 * echoing the brand mark's trail-of-dots; unlit dots are hairline rings.
 */

export type TrailStage = "heard" | "answered" | "decided" | "closed";

const STAGES: Array<{ key: TrailStage; label: string; r: number }> = [
  { key: "heard",    label: "Heard",    r: 2.2 },
  { key: "answered", label: "Answered", r: 2.6 },
  { key: "decided",  label: "Decided",  r: 3.0 },
  { key: "closed",   label: "Closed",   r: 3.4 },
];

// Statuses that mean a decision was made (past open/review triage).
const DECIDED = new Set(["planned", "progress", "shipped", "declined", "deferred", "duplicate"]);
// Statuses where the customer hears the outcome — the loop is closed.
const CLOSED = new Set(["shipped", "declined", "duplicate"]);

export type TrailProgress = { heard: boolean; answered: boolean; decided: boolean; closed: boolean };

/** Derive stage progress from the fields both the inbox and thread already have. */
export function trailProgress(item: { status: string; vendorReplied: boolean }): TrailProgress {
  return {
    heard: true,
    answered: item.vendorReplied,
    decided: DECIDED.has(item.status),
    closed: CLOSED.has(item.status),
  };
}

export function TrailDots({ progress, size = 12 }: { progress: TrailProgress; size?: number }) {
  const lit = STAGES.filter(s => progress[s.key]).map(s => s.label);
  const title = `Trail: ${lit.join(" → ")}${progress.closed ? " · loop closed" : " · loop open"}`;
  // Dots sit on a shared baseline, spaced 9 units apart in a 36×10 viewBox.
  return (
    <svg
      viewBox="0 0 36 10"
      width={size * 3}
      height={size * (10 / 12)}
      role="img"
      aria-label={title}
      style={{ flexShrink: 0, display: "block" }}
    >
      <title>{title}</title>
      {STAGES.map((s, i) => {
        const on = progress[s.key];
        const cx = 4.5 + i * 9;
        return on ? (
          <circle key={s.key} cx={cx} cy="5" r={s.r} fill="var(--ember)" opacity={0.45 + i * 0.18} />
        ) : (
          <circle key={s.key} cx={cx} cy="5" r={s.r - 0.5} fill="none" stroke="var(--hair-strong, var(--hair))" strokeWidth="1" />
        );
      })}
    </svg>
  );
}
