/**
 * Loop semantics: every item is an open loop until the customer has heard the
 * outcome. "Whose turn" is derived from who moved last (`lastReplySide`, from
 * lastTurnSideSql in lib/loop-sql.ts). A vendor reply, a status email the
 * customer actually got, or setting the item aside puts the ball in their
 * court; a customer reply (or nothing yet) means the loop is waiting on you.
 * Terminal statuses close the loop: the customer is notified of
 * shipped/declined, and merged duplicates live under their canonical item.
 *
 * Pure module (no db imports) so the derivation is unit-testable and shared
 * between the inbox query mapping and the client table. The status sets come
 * from @crumb/ui, the one definition the trail dots and SQL counts
 * (lib/loop-sql.ts) also use.
 */

import { CLOSED_STATUSES } from "@crumb/ui";

export type LoopTurn = "yours" | "waiting" | "closed";

export type ReplySide = "vendor" | "customer";

/**
 * Statuses where the loop is closed: an outcome was reached
 * (shipped/declined/duplicate) or the customer closed it themselves from the
 * widget ("resolved").
 */
export const LOOP_CLOSED_STATUSES: ReadonlySet<string> = CLOSED_STATUSES;

export function loopTurn(item: { status: string; lastReplySide: ReplySide | null }): LoopTurn {
  if (LOOP_CLOSED_STATUSES.has(item.status)) return "closed";
  return item.lastReplySide === "vendor" ? "waiting" : "yours";
}

/**
 * How long the loop has been waiting on the vendor: since the customer's last
 * message if they replied after your last move, otherwise since the item
 * arrived. With side 'customer' the latest non-internal reply is theirs, so
 * lastExternalReplyAtIso is that message.
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

// ponytail: items keep the tracker's state name (Linear, Jira) or issue state
// (GitHub), not Linear's state type or Jira's status category, so a done state
// is recognised by name. A team that renames its done state won't match; store
// the category at sync time if that bites.
const TICKET_DONE_STATES: ReadonlySet<string> = new Set(["done", "completed", "closed", "resolved"]);

/**
 * Engineering finished the linked ticket: Linear's Done (completed) state, a
 * Jira status named Done, Closed or Resolved, or a closed GitHub issue.
 */
export function ticketDone(provider: string | null, status: string | null): boolean {
  return !!provider && !!status && TICKET_DONE_STATES.has(status.trim().toLowerCase());
}

/**
 * Engineering is done but the customer hasn't heard: an open loop whose linked
 * ticket is done, with no delivered notification since the ticket last synced
 * (the tracker reporting that state). Timestamps are toISOString() strings.
 */
// ponytail: the last sync stands in for "when it went done". Linear and GitHub
// re-sync on any issue edit, so an edit after the customer was told flags the
// item again. Stamp the status-change time at sync if that bites.
export function engDoneUntold(item: {
  status: string;
  externalProvider: string | null;
  externalStatus: string | null;
  externalSyncedAtIso: string | null;
  lastNotifiedAtIso: string | null;
}): boolean {
  if (LOOP_CLOSED_STATUSES.has(item.status) || !ticketDone(item.externalProvider, item.externalStatus)) return false;
  return !item.lastNotifiedAtIso
    || (item.externalSyncedAtIso !== null && item.lastNotifiedAtIso < item.externalSyncedAtIso);
}
