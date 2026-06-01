import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@crumb/db";

// Usage-event retention. The usage_events table is the one high-cardinality
// telemetry table; without a sweep it grows unbounded. We drop events older
// than the retention window (default 180 days; env override). The aggregations
// that read it (account signals, churn trend, initiative impact, AI queries)
// only ever look back ≤90 days, so this never affects a live surface.
//
// Deletes in bounded batches so a backlog can't lock the table for long; the
// cron calls it repeatedly until `deleted < limit`.

const DEFAULT_RETENTION_DAYS = 180;
const DEFAULT_LIMIT = 5_000;

function retentionDays(): number {
  const v = parseInt(process.env.CRUMB_USAGE_EVENTS_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RETENTION_DAYS;
}

export async function sweepAgedUsageEvents(opts: { limit?: number } = {}): Promise<{ usageEventsDeleted: number }> {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const days = retentionDays();
  // Batched delete via a CTE selecting the oldest ids past the window.
  const rows = (await db.execute(sql`
    WITH doomed AS (
      SELECT id FROM usage_events
      WHERE ts < now() - (${days} || ' days')::interval
      LIMIT ${limit}
    )
    DELETE FROM usage_events WHERE id IN (SELECT id FROM doomed)
    RETURNING id
  `)) as unknown as unknown[];
  return { usageEventsDeleted: rows.length };
}
