import "server-only";
import { eq, sql, type SQL } from "drizzle-orm";
import { db, items } from "@crumb/db";

// A request as its customer sees it. One merged into another (status
// "duplicate" with merged_into_id set) follows that request, the way the
// status emails already tell it: it reads with that request's status, and
// nothing else of it (title, account, words and customers stay out). Except
// "resolved", which is that request's own customer closing it, not an outcome:
// then it keeps reading as combined, with nothing to report.
//
// For a query on `items`. Raw, fully-qualified refs (the inner copy is `c`):
// drizzle renders an interpolated column unqualified inside a raw subquery.

export function customerStatusSql(): SQL<string> {
  return sql<string>`CASE
    WHEN items.status = 'duplicate' AND items.merged_into_id IS NOT NULL THEN COALESCE(
      (SELECT c.status FROM items c WHERE c.id = items.merged_into_id AND c.status <> 'resolved'),
      items.status)
    ELSE items.status END`;
}

/** Merged into another request: its status is that one's (customerStatusSql). */
export function mergedSql(): SQL<boolean> {
  return sql<boolean>`(items.status = 'duplicate' AND items.merged_into_id IS NOT NULL)`;
}

/** One request's status as its customer sees it; null when it's gone. */
export async function customerStatusOf(itemId: string): Promise<{ status: string; merged: boolean } | null> {
  const [row] = await db
    .select({ status: customerStatusSql(), merged: mergedSql() })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  return row ?? null;
}
