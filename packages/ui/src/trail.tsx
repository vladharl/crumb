"use client";

/**
 * TrailDots — the loop made visible. Four crumbs along an item's trail:
 * heard (it arrived) → answered (a vendor replied) → decided (status moved
 * past triage) → closed (the customer heard the outcome). Lit dots grow,
 * echoing the brand mark's trail-of-dots; unlit dots are hairline rings.
 *
 * Motion (see globals.css .trail-dots): as a stage lights, its fill grows in
 * from a seed while the ring crossfades out — so advancing a loop is *felt*,
 * not just re-rendered. When the loop actually closes, the trail runs a one-shot
 * beat: the crumbs ripple left→right, an ember comet travels the whole trail,
 * and the final crumb blooms with a soft glow as it lands — "the customer heard
 * back", made physical. The beat is mount-guarded so an already-closed item that
 * simply renders (page load, scrolling into view) never celebrates retroactively.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";

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

  // One-shot ripple when the loop transitions open → closed in this session.
  const [rippling, setRippling] = useState(false);
  const mounted = useRef(false);
  const wasClosed = useRef(progress.closed);
  useEffect(() => {
    if (!mounted.current) {
      // First render: adopt the incoming state without celebrating it.
      mounted.current = true;
      wasClosed.current = progress.closed;
      return;
    }
    if (progress.closed && !wasClosed.current) {
      setRippling(true);
      // Outlast the longest strand of the beat (terminus bloom: 300ms delay +
      // 520ms run) so the rippling class is present for the whole celebration.
      const t = setTimeout(() => setRippling(false), 900);
      wasClosed.current = true;
      return () => clearTimeout(t);
    }
    wasClosed.current = progress.closed;
  }, [progress.closed]);

  // Dots sit on a shared baseline, spaced 9 units apart in a 36×10 viewBox.
  // Each stage renders both a ring (unlit) and a fill (lit), crossfaded by
  // opacity so the transition between states is continuous and animatable.
  return (
    <svg
      className={rippling ? "trail-dots rippling" : "trail-dots"}
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
        return (
          <g key={s.key} style={{ "--i": i } as CSSProperties}>
            <circle
              className="trail-ring"
              cx={cx}
              cy="5"
              r={s.r - 0.5}
              fill="none"
              stroke="var(--hair-strong, var(--hair))"
              strokeWidth="1"
              style={{ opacity: on ? 0 : 1 }}
            />
            <circle
              className="trail-fill"
              cx={cx}
              cy="5"
              r={s.r}
              fill="var(--ember)"
              style={{ opacity: on ? 0.45 + i * 0.18 : 0, transform: on ? "scale(1)" : "scale(0.25)" }}
            />
          </g>
        );
      })}
      {/* The comet that runs the trail when the loop closes — the signal
          travelling out to the customer. Invisible at rest; the .rippling
          animation (globals.css) sweeps it left→right exactly once. */}
      <circle className="trail-comet" cx="4.5" cy="5" r="1.6" fill="var(--ember)" />
    </svg>
  );
}
