import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, integrationConnections, type Workspace, type IntegrationConnection } from "@crumb/db";
import { getFeedbackAdapter } from "./index";
import { FeedbackSyncError, type FeedbackProvider, type SyncFailure } from "./types";
import { ingestRecord, type IngestOutcome } from "@/lib/feedback/ingest";
import { log } from "@/lib/log";

// Drive one inbound connection: claim it, page through new records since the
// stored cursor, run each through the "new & relevant" gate, and record the
// outcome. A run stops after MAX_PAGES or RUN_BUDGET_MS and saves the cursor
// after every finished page, so the next run picks up where this one stopped
// (records it already captured are skipped, see ingestRecord).
//
// Failures (SyncFailure in types.ts): auth and config put the connection in an
// error state right away, since only the admin can fix them. A transient one
// keeps the cursor and the status; the cron retries with backoff (syncDue) and
// after MAX_FAILURES in a row the connection shows as an error, but the cron
// still retries it every few hours so it recovers once the provider is back.

const MAX_PAGES = 10;
const RUN_BUDGET_MS = 5 * 60_000;
// "Sync now" waits for the run, behind a proxy that gives up at ~100 s
// (Cloudflare). Whatever is left syncs on the next run.
// ponytail: one record's AI call can still run past the proxy; run the manual
// sync in the background and poll, like the CRM card, if that shows up.
export const MANUAL_RUN_BUDGET_MS = 45_000;
export const MAX_FAILURES = 5;
const BACKOFF_BASE_MS = 15 * 60_000;
const BACKOFF_CAP_MS = 6 * 60 * 60_000;

// The claim and the failure streak ride in the connection's config jsonb, next
// to the admin's settings (reconnecting replaces config, which resets both).
// ponytail: integration_connections has no columns for them; move them to
// syncing_since / sync_failures with the next migration that touches the table.
type SyncState = { syncingSince?: string; failures?: number };
const cfg = integrationConnections.config;

export type FeedbackSyncResult =
  | { ok: true; provider: FeedbackProvider; pulled: number; outcome: IngestOutcome; more: boolean }
  | { ok: false; provider: FeedbackProvider; error: SyncFailure | "sync_running" | "unknown_provider" };

export function syncFailures(conn: Pick<IntegrationConnection, "config">): number {
  return Number((conn.config as SyncState | null)?.failures ?? 0);
}

// Whether the cron should try this connection now. auth/config errors wait for
// the admin; a failure streak waits out its backoff (15 min, doubling, 6 h cap),
// measured from the last attempt (updatedAt).
export function syncDue(
  conn: Pick<IntegrationConnection, "status" | "error" | "config" | "updatedAt">,
  now: number = Date.now(),
): boolean {
  if (conn.status === "error" && conn.error !== "transient") return false;
  const failures = syncFailures(conn);
  if (failures === 0) return true;
  return now >= conn.updatedAt.getTime() + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
}

function addOutcome(a: IngestOutcome, b: IngestOutcome): IngestOutcome {
  return {
    promoted: a.promoted + b.promoted,
    attached: a.attached + b.attached,
    held: a.held + b.held,
    dropped: a.dropped + b.dropped,
    skipped: a.skipped + b.skipped,
  };
}

// Take the connection for this run with a conditional UPDATE, so a second run
// (the cron and "Sync now" together) gets no row back and skips instead of
// ingesting the same records twice. Returns the fresh row (latest cursor). A
// claim older than 30 minutes belongs to a run that died and may be taken over;
// that is well past RUN_BUDGET_MS plus one slow record.
async function claim(id: string): Promise<IntegrationConnection | null> {
  const [row] = await db
    .update(integrationConnections)
    .set({ config: sql`coalesce(${cfg}, '{}'::jsonb) || jsonb_build_object('syncingSince', now())` })
    .where(and(
      eq(integrationConnections.id, id),
      sql`((${cfg}->>'syncingSince') is null or (${cfg}->>'syncingSince')::timestamptz < now() - interval '30 minutes')`,
    ))
    .returning();
  return row ?? null;
}

export async function syncFeedbackSource(
  ws: Workspace,
  connection: IntegrationConnection,
  budgetMs: number = RUN_BUDGET_MS,
): Promise<FeedbackSyncResult> {
  const provider = connection.provider as FeedbackProvider;
  const adapter = getFeedbackAdapter(provider);
  if (!adapter) return { ok: false, provider, error: "unknown_provider" };

  const conn = await claim(connection.id);
  if (!conn) return { ok: false, provider, error: "sync_running" };

  const deadline = Date.now() + budgetMs;
  let cursor = conn.syncCursor;
  let pulled = 0;
  let done = false;
  let outcome: IngestOutcome = { promoted: 0, attached: 0, held: 0, dropped: 0, skipped: 0 };

  try {
    for (let page = 0; page < MAX_PAGES && !done && Date.now() < deadline; page++) {
      const res = await adapter.listSince(conn, cursor);
      let finished = true;
      for (const record of res.records) {
        if (Date.now() >= deadline) { finished = false; break; }
        pulled++;
        outcome = addOutcome(outcome, await ingestRecord(ws, provider, record));
      }
      // Out of time mid-page: keep the page's starting cursor so the rest of
      // it is read next run.
      if (!finished) break;
      if (res.nextCursor != null) cursor = res.nextCursor;
      await db.update(integrationConnections).set({ syncCursor: cursor }).where(eq(integrationConnections.id, conn.id));
      done = res.done;
    }
  } catch (err) {
    const reason: SyncFailure = err instanceof FeedbackSyncError ? err.reason : "transient";
    const failures = syncFailures(conn) + 1;
    const status = reason === "transient" && failures < MAX_FAILURES ? "active" : "error";
    log.error("feedback sync failed", { scope: `crumb/${provider}`, workspaceId: ws.id, reason, failures, err });
    await db
      .update(integrationConnections)
      .set({
        status,
        error: reason,
        updatedAt: new Date(),
        config: sql`(${cfg} - 'syncingSince') || jsonb_build_object('failures', ${failures}::int)`,
      })
      .where(eq(integrationConnections.id, conn.id));
    return { ok: false, provider, error: reason };
  }

  await db
    .update(integrationConnections)
    .set({
      syncCursor: cursor,
      lastSyncedAt: new Date(),
      status: "active",
      error: null,
      updatedAt: new Date(),
      config: sql`${cfg} - 'syncingSince' - 'failures'`,
    })
    .where(eq(integrationConnections.id, conn.id));

  log.info("feedback sync ran", { scope: `crumb/${provider}`, workspaceId: ws.id, pulled, more: !done, ...outcome });
  return { ok: true, provider, pulled, outcome, more: !done };
}
