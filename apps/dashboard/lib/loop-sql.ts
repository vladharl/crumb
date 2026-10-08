import "server-only";
import { isNull, notInArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { CLOSED_STATUSES } from "@crumb/ui";

// SQL twins of the shared loop sets in @crumb/ui, so server-side counts agree
// with the inbox buckets (lib/loop.ts) and the trail dots. Pass the column
// (`items.status`): the fragment nests, so drizzle keeps it qualified
// ("items"."status") even inside a raw correlated subquery. When the query
// aliases the table (`from items i`), pass a raw ref instead: sql`i.status`.

const CLOSED = [...CLOSED_STATUSES];

/** Status is open: anything not closed ("deferred" included), like loopTurn(). */
export function loopOpenSql(status: SQLWrapper): SQL {
  return notInArray(status, CLOSED);
}

/** Not a duplicate folded into a canonical item, so each loop counts once. */
export function notMergedSql(mergedIntoId: SQLWrapper): SQL {
  return isNull(mergedIntoId);
}

/**
 * Whose move it was last: the `lastReplySide` loopTurn() reads. 'vendor' when
 * the newest vendor touch is newer than the newest customer reply. A touch is a
 * non-internal vendor reply, a delivered customer notification (the ledger: a
 * reply or status email a provider accepted), or setting the item aside.
 * 'customer' when the customer's reply is newest (a tie goes to the customer,
 * so nothing slips); null when neither exists. Pass the column (`items.id`),
 * or a raw ref when the query aliases the table.
 */
export function lastTurnSideSql(itemId: SQLWrapper): SQL<"vendor" | "customer" | null> {
  // Wrapped so the column is a nested fragment: drizzle drops the table name
  // from a column sitting directly in a single-table select field, and a bare
  // "id" in here would bind to replies.id.
  const id = sql`${itemId}`;
  return sql<"vendor" | "customer" | null>`(
    SELECT CASE
      WHEN t.vendor_at IS NULL AND t.customer_at IS NULL THEN NULL
      WHEN t.customer_at IS NULL OR t.vendor_at > t.customer_at THEN 'vendor'
      ELSE 'customer'
    END
    FROM (SELECT
      GREATEST(
        (SELECT MAX(r.created_at) FROM replies r
          WHERE r.item_id = ${id} AND r.internal = false AND r.workspace_user_id IS NOT NULL),
        (SELECT MAX(cn.sent_at) FROM customer_notifications cn WHERE cn.item_id = ${id}),
        (SELECT MAX(se.at) FROM status_events se WHERE se.item_id = ${id} AND se.to_status = 'deferred')
      ) AS vendor_at,
      (SELECT MAX(r.created_at) FROM replies r
        WHERE r.item_id = ${id} AND r.internal = false AND r.workspace_user_id IS NULL) AS customer_at
    ) t
  )`;
}
