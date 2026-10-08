import "server-only";
import { isNull, notInArray, type SQL, type SQLWrapper } from "drizzle-orm";
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
