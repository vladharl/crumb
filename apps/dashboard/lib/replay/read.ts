import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db, replaySessions, replayChunks, items } from "@crumb/db";
import { getBytes } from "@/lib/storage";

// Shape consumed by ReplaySessionCard + the player manifest endpoint.
// Kept small — the heavy bytes live behind the per-sequence endpoint.
export type ReplayManifest = {
  id: string;
  itemId: string | null;
  startedAt: string;
  endedAt: string | null;
  pageUrl: string | null;
  userAgent: string | null;
  viewportW: number | null;
  viewportH: number | null;
  screenW: number | null;
  screenH: number | null;
  deviceType: string | null;
  browserName: string | null;
  browserVersion: string | null;
  osName: string | null;
  osVersion: string | null;
  callerIp: string | null;
  geoCountry: string | null;
  geoCity: string | null;
  eventCount: number;
  sizeBytes: number;
  durationMs: number;
  chunks: Array<{ sequence: number; sizeBytes: number; eventCount: number; startedAt: string; endedAt: string }>;
};

// Vendor-side read. Workspace-scoped: the session must belong to the
// caller's workspace. Returns null for not-found OR cross-tenant requests
// (don't leak which) — the dashboard route maps that to 404.
export async function getManifest(
  replaySessionId: string,
  workspaceId: string,
): Promise<ReplayManifest | null> {
  const [session] = await db
    .select()
    .from(replaySessions)
    .where(and(
      eq(replaySessions.id, replaySessionId),
      eq(replaySessions.workspaceId, workspaceId),
    ))
    .limit(1);
  if (!session) return null;

  const chunks = await db
    .select({
      sequence: replayChunks.sequence,
      sizeBytes: replayChunks.sizeBytes,
      eventCount: replayChunks.eventCount,
      startedAt: replayChunks.startedAt,
      endedAt: replayChunks.endedAt,
    })
    .from(replayChunks)
    .where(eq(replayChunks.sessionId, session.id))
    .orderBy(asc(replayChunks.sequence));

  const durationMs = session.endedAt
    ? session.endedAt.getTime() - session.startedAt.getTime()
    : 0;

  return {
    id: session.id,
    itemId: session.itemId,
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt ? session.endedAt.toISOString() : null,
    pageUrl: session.pageUrl,
    userAgent: session.userAgent,
    viewportW: session.viewportW,
    viewportH: session.viewportH,
    screenW: session.screenW,
    screenH: session.screenH,
    deviceType: session.deviceType,
    browserName: session.browserName,
    browserVersion: session.browserVersion,
    osName: session.osName,
    osVersion: session.osVersion,
    callerIp: session.callerIp,
    geoCountry: session.geoCountry,
    geoCity: session.geoCity,
    eventCount: session.eventCount,
    sizeBytes: session.sizeBytes,
    durationMs,
    chunks: chunks.map(c => ({
      sequence: c.sequence,
      sizeBytes: c.sizeBytes,
      eventCount: c.eventCount,
      startedAt: c.startedAt.toISOString(),
      endedAt: c.endedAt.toISOString(),
    })),
  };
}

// Streams the chunk's events as a Buffer. Caller is responsible for
// workspace scoping — we re-check it here so the chunk URL alone can't
// leak content from a sibling workspace.
export async function getChunk(
  replaySessionId: string,
  sequence: number,
  workspaceId: string,
): Promise<Buffer | null> {
  const [row] = await db
    .select({ storageKey: replayChunks.storageKey })
    .from(replayChunks)
    .innerJoin(replaySessions, eq(replaySessions.id, replayChunks.sessionId))
    .where(and(
      eq(replayChunks.sessionId, replaySessionId),
      eq(replayChunks.sequence, sequence),
      eq(replaySessions.workspaceId, workspaceId),
    ))
    .limit(1);
  if (!row) return null;
  return getBytes(row.storageKey);
}

// Look up the linked replay session for a feedback item. Used by the
// thread sidebar card to decide whether to show "Watch replay".
export async function getReplayForItem(
  itemShortId: string,
  workspaceId: string,
): Promise<ReplayManifest | null> {
  const [row] = await db
    .select({ replayId: replaySessions.id })
    .from(replaySessions)
    .innerJoin(items, eq(items.id, replaySessions.itemId))
    .where(and(
      eq(items.shortId, itemShortId),
      eq(items.workspaceId, workspaceId),
    ))
    .limit(1);
  if (!row) return null;
  return getManifest(row.replayId, workspaceId);
}
