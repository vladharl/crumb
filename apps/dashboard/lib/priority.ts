/**
 * Revenue priority: Crumb's second design principle made computable —
 * "revenue is the unit of priority, not raw upvote count." Every open loop
 * carries an *ARR at stake*: the summed ARR of the distinct accounts asking
 * for it (the item plus any duplicates merged into it). That dollar figure is
 * always the visible unit; the composite below only decides the *order*.
 *
 * The composite is revenue-anchored on purpose. ARR-at-stake is the base, and
 * reach (how many accounts), severity, and customer wait act as bounded
 * multipliers that nudge ranking *within* a revenue neighbourhood — they never
 * let a small ask leapfrog a much larger one. Each multiplier reads back as a
 * plain "+30%", so the ranking is explainable, not a black box (principle 5,
 * "the tool disappears" — no mystery score is ever shown).
 *
 * Graceful degradation falls out of the data: ai_severity is null on self-host
 * (AI is Cloud-only), so the severity multiplier is 1.0 and simply drops out of
 * the breakdown — same trick lib/insights/churn.ts relies on. No edition flag.
 *
 * Pure module (no React/db/DOM) so it is unit-testable and shared by the inbox
 * client sort, the thread header, and the initiative rollup. `now` is passed in
 * (not read) so scoring is deterministic.
 */

import { loopTurn, waitingSince, waitingDays, type ReplySide } from "./loop";

export type PriorityInput = {
  /** ARR summed over the distinct accounts in the merge group, in cents. */
  arrAtStakeCents: number;
  /** Distinct accounts asking (the merge group's account count); >= 1. */
  reachAccounts: number;
  /** AI severity (low|medium|high|critical) or null when not triaged / self-host. */
  aiSeverity: string | null;
  status: string;
  lastReplySide: ReplySide | null;
  createdAtIso: string;
  lastExternalReplyAtIso: string | null;
};

/** One line of the "why this rank" breakdown — a human-readable contribution. */
export type PriorityFactor = {
  key: "revenue" | "reach" | "severity" | "wait";
  label: string;
  /** Multiplier as a signed percentage string ("+40%"), or null for the base. */
  delta: string | null;
};

export type Priority = {
  /** The composite sort key. Revenue-dominant; ties broken by signalScore. */
  score: number;
  /** Non-revenue contribution only — orders items that share an ARR (incl. $0). */
  signalScore: number;
  arrAtStakeCents: number;
  reachAccounts: number;
  /** Whether severity actually contributed (entitled AND triaged AND medium+). */
  severityActive: boolean;
  factors: PriorityFactor[];
  /** One-line tooltip text joining the factors — the inbox's "why" affordance. */
  summary: string;
};

// Severity → multiplier. low/none are neutral; the ramp stays gentle so a
// critical bug lifts a high-ARR item but can't outweigh an order-of-magnitude
// revenue gap. null (self-host / untriaged) is neutral and omitted from "why".
const SEVERITY_MULT: Record<string, number> = {
  low: 1.0,
  medium: 1.2,
  high: 1.5,
  critical: 1.9,
};

const REACH_STEP = 0.2; // +20% per additional account asking…
const REACH_MAX_MULT = 2.0; // …capped at +100% (≈6 accounts).
const WAIT_CAP_DAYS = 30; // wait saturates at 30 days…
const WAIT_MAX_BONUS = 0.5; // …worth at most +50%, and only while it's your turn.

function pct(mult: number): string {
  return `${mult >= 1 ? "+" : ""}${Math.round((mult - 1) * 100)}%`;
}

function severityMult(aiSeverity: string | null): number {
  if (!aiSeverity) return 1;
  return SEVERITY_MULT[aiSeverity] ?? 1;
}

function reachMult(reachAccounts: number): number {
  return Math.min(1 + REACH_STEP * Math.max(0, reachAccounts - 1), REACH_MAX_MULT);
}

/** Days the customer has been waiting on us — only counts while it's our turn. */
function waitDaysFor(input: PriorityInput, now: number): number {
  if (loopTurn(input) !== "yours") return 0;
  return waitingDays(waitingSince(input), now);
}

function waitMult(waitDays: number): number {
  return 1 + (Math.min(waitDays, WAIT_CAP_DAYS) / WAIT_CAP_DAYS) * WAIT_MAX_BONUS;
}

/**
 * Compute the revenue-anchored composite for one item. `now` is the reference
 * time for the customer-wait term (pass Date.now() at the call site).
 */
export function priority(input: PriorityInput, now: number): Priority {
  const arrDollars = Math.max(0, input.arrAtStakeCents) / 100;
  const sev = severityMult(input.aiSeverity);
  const reach = reachMult(input.reachAccounts);
  const waitDays = waitDaysFor(input, now);
  const wait = waitMult(waitDays);

  const score = arrDollars * sev * reach * wait;
  // Non-revenue lift expressed in "points" so $0 items still order sensibly
  // among themselves (a multi-account critical bug leads its zero-ARR peers).
  const signalScore = (sev - 1) * 100 + (reach - 1) * 50 + (wait - 1) * 40;

  const factors: PriorityFactor[] = [
    {
      key: "revenue",
      label: input.arrAtStakeCents > 0 ? "ARR at stake" : "No ARR set on the account",
      delta: null,
    },
  ];
  if (input.reachAccounts > 1) {
    factors.push({ key: "reach", label: `${input.reachAccounts} accounts asking`, delta: pct(reach) });
  }
  const severityActive = sev > 1;
  if (severityActive) {
    factors.push({ key: "severity", label: `${input.aiSeverity} severity`, delta: pct(sev) });
  }
  if (waitDays >= 1) {
    const days = Math.round(waitDays);
    factors.push({ key: "wait", label: `waiting ${days}${days === 1 ? " day" : " days"}`, delta: pct(wait) });
  }

  const summary = factors
    .map(f => (f.delta ? `${f.label} (${f.delta})` : f.label))
    .join(" · ");

  return {
    score,
    signalScore,
    arrAtStakeCents: input.arrAtStakeCents,
    reachAccounts: input.reachAccounts,
    severityActive,
    factors,
    summary,
  };
}

/**
 * Descending priority comparator: revenue-weighted score first, then the
 * non-revenue signal (so equal- and zero-ARR items still order by reach /
 * severity / wait), then newest-first as a stable final tiebreak.
 */
export function byPriorityDesc(
  a: Priority & { createdAtIso: string },
  b: Priority & { createdAtIso: string },
): number {
  return (
    b.score - a.score ||
    b.signalScore - a.signalScore ||
    b.createdAtIso.localeCompare(a.createdAtIso)
  );
}

/**
 * Shared ARR formatter. The four pre-existing per-page `arr()` copies disagree
 * on the zero case; new revenue-priority surfaces all route through this one so
 * "$480k" / "$1.2M" reads identically everywhere. Callers decide how to render
 * zero (the inbox shows "ARR not set", never "$0").
 */
export function formatArr(cents: number): string {
  if (cents <= 0) return "$0";
  if (cents >= 100_000_000) return `$${(cents / 100_000_000).toFixed(1)}M`;
  if (cents >= 100_000) return `$${Math.round(cents / 100_000)}k`;
  return `$${Math.round(cents / 100)}`;
}
