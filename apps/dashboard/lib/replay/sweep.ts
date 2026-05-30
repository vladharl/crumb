import "server-only";
import { and, isNull, lt, eq, inArray } from "drizzle-orm";
import { db, replaySessions, replayChunks, workspaces } from "@crumb/db";
import { deleteBytes } from "@/lib/storage";
import { workspacePlan, type Plan } from "@/lib/entitlements";

// Sweep orphan replay_sessions — rows with no `item_id` set, older than
// the grace window. The widget links a token to an item only after the
// customer hits submit; sessions that never resulted in feedback (the
// customer closed the tab, never opened the widget, etc.) sit here
// indefinitely until something prunes them.
//
// Strategy:
//   1. Find candidate session ids.
//   2. For each candidate, gather chunk storage_keys + delete the bytes.
//   3. Delete the replay_sessions rows; CASCADE drops replay_chunks rows.
//
// We do *not* rely on a single transaction. Bytes live in object storage
// (currently local disk; S3 in the future) — best-effort delete then drop
// the DB rows. Operators get an `orphanedStorageKeys` count back if any
// bytes failed; the row delete still completes (we'd rather have orphan
// blobs than orphan DB rows pointing at missing bytes).

export type SweepResult = {
  scanned: number;
  deletedSessions: number;
  deletedChunks: number;
  releasedBytes: number;
  storageFailures: number;
};

export type SweepOptions = {
  // Sessions younger than this are skipped — gives a customer time to
  // come back and submit feedback after a chunk has been recorded. Default
  // 24h: comfortably past any tab-close-and-come-back-later pattern.
  graceMs?: number;
  // Safety cap on rows touched per invocation. Lets operators run on a
  // tight cron without one giant batch holding a lock.
  limit?: number;
};

const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 500;

export async function sweepOrphanSessions(opts: SweepOptions = {}): Promise<SweepResult> {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const cutoff = new Date(Date.now() - graceMs);

  const candidates = await db
    .select({ id: replaySessions.id })
    .from(replaySessions)
    .where(and(
      isNull(replaySessions.itemId),
      lt(replaySessions.startedAt, cutoff),
    ))
    .limit(limit);

  if (candidates.length === 0) {
    return { scanned: 0, deletedSessions: 0, deletedChunks: 0, releasedBytes: 0, storageFailures: 0 };
  }

  const sessionIds = candidates.map(c => c.id);
  const chunks = await db
    .select({ id: replayChunks.id, storageKey: replayChunks.storageKey, sizeBytes: replayChunks.sizeBytes })
    .from(replayChunks)
    .where(inArray(replayChunks.sessionId, sessionIds));

  let releasedBytes = 0;
  let storageFailures = 0;
  for (const c of chunks) {
    try {
      await deleteBytes(c.storageKey);
      releasedBytes += c.sizeBytes;
    } catch {
      storageFailures += 1;
    }
  }

  // CASCADE on replay_chunks → replay_sessions handles the join rows;
  // we delete the parent in a single statement to keep the row count
  // honest in the return value.
  for (const id of sessionIds) {
    await db.delete(replaySessions).where(eq(replaySessions.id, id));
  }

  return {
    scanned: candidates.length,
    deletedSessions: sessionIds.length,
    deletedChunks: chunks.length,
    releasedBytes,
    storageFailures,
  };
}

// ─── plan-aware retention ────────────────────────────────────
// Prunes replay sessions (orphan OR linked) older than a per-plan retention
// window. This is the cost-control counterpart to the orphan sweep above —
// it bounds how long replay bytes live, not just whether they ever linked.
//
// OPT-IN by design: returns immediately unless a retention window is
// configured, so existing deployments never silently delete linked replays.
// Configure via env:
//   CRUMB_REPLAY_RETENTION_DAYS            global default (all plans)
//   CRUMB_REPLAY_RETENTION_DAYS_GROWTH     per-plan override (also _TEAM/_FREE)
// Per-plan takes precedence over the global; 0/unset = keep forever.

export type RetentionResult = {
  workspacesScanned: number;
  deletedSessions: number;
  deletedChunks: number;
  releasedBytes: number;
  storageFailures: number;
};

function retentionDaysForPlan(plan: Plan): number {
  const perPlan = parseInt(process.env[`CRUMB_REPLAY_RETENTION_DAYS_${plan.toUpperCase()}`] ?? "", 10);
  if (Number.isFinite(perPlan) && perPlan > 0) return perPlan;
  const global = parseInt(process.env.CRUMB_REPLAY_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(global) && global > 0 ? global : 0;
}

export async function sweepAgedSessions(opts: { limit?: number } = {}): Promise<RetentionResult> {
  const limit = opts.limit ?? 500;
  const empty: RetentionResult = { workspacesScanned: 0, deletedSessions: 0, deletedChunks: 0, releasedBytes: 0, storageFailures: 0 };

  // Fast path: nothing configured → no-op, no DB work.
  if (retentionDaysForPlan("free") === 0 && retentionDaysForPlan("team") === 0 && retentionDaysForPlan("growth") === 0) {
    return empty;
  }

  // Distinct workspaces that actually have replay data, with plan fields.
  const wss = await db
    .selectDistinct({
      id: workspaces.id,
      planId: workspaces.planId,
      subscriptionStatus: workspaces.subscriptionStatus,
    })
    .from(replaySessions)
    .innerJoin(workspaces, eq(workspaces.id, replaySessions.workspaceId));

  const result = { ...empty };
  for (const ws of wss) {
    const days = retentionDaysForPlan(workspacePlan(ws));
    if (days <= 0) continue;
    result.workspacesScanned++;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const aged = await db
      .select({ id: replaySessions.id })
      .from(replaySessions)
      .where(and(eq(replaySessions.workspaceId, ws.id), lt(replaySessions.startedAt, cutoff)))
      .limit(limit);
    if (aged.length === 0) continue;

    const ids = aged.map(a => a.id);
    const chunks = await db
      .select({ storageKey: replayChunks.storageKey, sizeBytes: replayChunks.sizeBytes })
      .from(replayChunks)
      .where(inArray(replayChunks.sessionId, ids));
    for (const c of chunks) {
      try {
        await deleteBytes(c.storageKey);
        result.releasedBytes += c.sizeBytes;
      } catch {
        result.storageFailures++;
      }
    }
    for (const id of ids) {
      await db.delete(replaySessions).where(eq(replaySessions.id, id));
    }
    result.deletedSessions += ids.length;
    result.deletedChunks += chunks.length;
  }
  return result;
}
