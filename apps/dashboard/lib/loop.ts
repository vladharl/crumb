/**
 * Loop semantics: every item is an open loop until the customer has heard the
 * outcome. "Whose turn" is derived from the last non-internal reply's side —
 * vendor replied last means the ball left your court; a customer reply (or no
 * vendor reply at all) means the loop is waiting on you. Terminal statuses
 * close the loop: the customer is notified of shipped/declined, and merged
 * duplicates live under their canonical item.
 *
 * Pure module (no React/db imports) so the derivation is unit-testable and
 * shared between the inbox query mapping and the client table.
 */

export type LoopTurn = "yours" | "waiting" | "closed";

export type ReplySide = "vendor" | "customer";

/** Statuses where the customer has been told the outcome — the loop is closed. */
export const LOOP_CLOSED_STATUSES: ReadonlySet<string> = new Set([
  "shipped",
  "declined",
  "duplicate",
]);

export function loopTurn(item: { status: string; lastReplySide: ReplySide | null }): LoopTurn {
  if (LOOP_CLOSED_STATUSES.has(item.status)) return "closed";
  return item.lastReplySide === "vendor" ? "waiting" : "yours";
}

/**
 * How long the loop has been waiting on the vendor: since the customer's last
 * message if they replied after you, otherwise since the item arrived.
 */
export function waitingSince(item: {
  createdAtIso: string;
  lastReplySide: ReplySide | null;
  lastExternalReplyAtIso: string | null;
}): string {
  if (item.lastReplySide === "customer" && item.lastExternalReplyAtIso) {
    return item.lastExternalReplyAtIso;
  }
  return item.createdAtIso;
}

/** Days a loop has sat unanswered — drives the age-chip color ramp. */
export function waitingDays(waitingSinceIso: string, now: number): number {
  return Math.max(0, (now - new Date(waitingSinceIso).getTime()) / 86_400_000);
}
