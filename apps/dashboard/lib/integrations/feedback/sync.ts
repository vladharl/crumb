import "server-only";
import { eq } from "drizzle-orm";
import { db, integrationConnections, type Workspace, type IntegrationConnection } from "@crumb/db";
import { getFeedbackAdapter } from "./index";
import type { FeedbackProvider } from "./types";
import { ingestRecord, type IngestOutcome } from "@/lib/feedback/ingest";
import { log } from "@/lib/log";

// Drive one inbound connection: page through new records since the stored cursor,
// run each through the "new & relevant" gate, advance the cursor, and record
// status. Bounded to MAX_PAGES per run so a backlog can't hold a cron tick open;
// the next run resumes from the persisted cursor.

const MAX_PAGES = 10;

export type FeedbackSyncResult =
  | { ok: true; provider: FeedbackProvider; pulled: number; outcome: IngestOutcome }
  | { ok: false; provider: FeedbackProvider; error: string };

function addOutcome(a: IngestOutcome, b: IngestOutcome): IngestOutcome {
  return {
    promoted: a.promoted + b.promoted,
    attached: a.attached + b.attached,
    held: a.held + b.held,
    dropped: a.dropped + b.dropped,
    skipped: a.skipped + b.skipped,
  };
}

export async function syncFeedbackSource(
  ws: Workspace,
  conn: IntegrationConnection,
): Promise<FeedbackSyncResult> {
  const provider = conn.provider as FeedbackProvider;
  const adapter = getFeedbackAdapter(provider);
  if (!adapter) return { ok: false, provider, error: "unknown_provider" };

  let cursor = conn.syncCursor;
  let pulled = 0;
  let outcome: IngestOutcome = { promoted: 0, attached: 0, held: 0, dropped: 0, skipped: 0 };

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await adapter.listSince(conn, cursor);
      for (const record of res.records) {
        pulled++;
        outcome = addOutcome(outcome, await ingestRecord(ws, provider, record));
      }
      if (res.nextCursor != null) cursor = res.nextCursor;
      if (res.done) break;
    }
  } catch (err) {
    log.error("feedback sync failed", { scope: `crumb/${provider}`, err });
    await db
      .update(integrationConnections)
      .set({ status: "error", error: String(err).slice(0, 500), updatedAt: new Date() })
      .where(eq(integrationConnections.id, conn.id));
    return { ok: false, provider, error: "sync_failed" };
  }

  await db
    .update(integrationConnections)
    .set({ syncCursor: cursor, lastSyncedAt: new Date(), status: "active", error: null, updatedAt: new Date() })
    .where(eq(integrationConnections.id, conn.id));

  log.info("feedback sync ran", { scope: `crumb/${provider}`, workspaceId: ws.id, pulled, ...outcome });
  return { ok: true, provider, pulled, outcome };
}
