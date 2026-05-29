import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, replaySessions, replayChunks, workspaces } from "@crumb/db";
import { newStorageKey, putBytes } from "@/lib/storage";

// Hard caps. Keep storage cost bounded; the recorder enforces matching
// caps client-side so well-behaved widgets stop before the server has to
// reject. Bad actors get a 413.
const MAX_SIZE_BYTES = 10 * 1024 * 1024;       // 10 MB / session
const MAX_EVENT_COUNT = 5000;                  // events / session
const MAX_DURATION_MS = 30 * 60 * 1000;        // 30 min / session

export type ChunkInput = {
  sessionToken: string;
  workspaceSlug: string;
  sequence: number;
  startedAt: Date;
  endedAt: Date;
  events: unknown[];
  pageUrl?: string | null;
  userAgent?: string | null;
  viewportW?: number | null;
  viewportH?: number | null;
};

export type ChunkResult =
  | { ok: true; sessionId: string; chunkId: string; capped: false }
  | { ok: false; status: number; error: string };

// Resolve or create the replay_sessions row from the (workspaceSlug,
// sessionToken) pair. The token is high-entropy (16 bytes) so the lookup
// is effectively the auth check on this endpoint — there's no JWT at
// session-start time. Cross-workspace token collisions are statistically
// impossible.
export async function recordChunk(input: ChunkInput): Promise<ChunkResult> {
  if (!input.sessionToken || input.sessionToken.length > 64) {
    return { ok: false, status: 400, error: "bad_token" };
  }
  if (!Array.isArray(input.events) || input.events.length === 0) {
    return { ok: false, status: 400, error: "empty_events" };
  }

  const [ws] = await db
    .select({ id: workspaces.id, sessionRecordEnabled: workspaces.sessionRecordEnabled })
    .from(workspaces)
    .where(eq(workspaces.slug, input.workspaceSlug))
    .limit(1);
  if (!ws) return { ok: false, status: 404, error: "workspace_not_found" };
  if (!ws.sessionRecordEnabled) return { ok: false, status: 403, error: "session_record_disabled" };

  // Serialize the chunk early so we know the byte size for cap accounting.
  const json = Buffer.from(JSON.stringify(input.events));
  const chunkSize = json.byteLength;
  const chunkEventCount = input.events.length;

  // Find-or-create the session row.
  let [session] = await db
    .select({
      id: replaySessions.id,
      startedAt: replaySessions.startedAt,
      eventCount: replaySessions.eventCount,
      sizeBytes: replaySessions.sizeBytes,
    })
    .from(replaySessions)
    .where(and(
      eq(replaySessions.workspaceId, ws.id),
      eq(replaySessions.sessionToken, input.sessionToken),
    ))
    .limit(1);

  if (!session) {
    const [created] = await db.insert(replaySessions).values({
      workspaceId: ws.id,
      sessionToken: input.sessionToken,
      startedAt: input.startedAt,
      pageUrl: input.pageUrl ?? null,
      userAgent: input.userAgent ?? null,
      viewportW: input.viewportW ?? null,
      viewportH: input.viewportH ?? null,
    }).returning({
      id: replaySessions.id,
      startedAt: replaySessions.startedAt,
      eventCount: replaySessions.eventCount,
      sizeBytes: replaySessions.sizeBytes,
    });
    session = created;
  }

  // Cap enforcement against running totals.
  const elapsedMs = input.endedAt.getTime() - session.startedAt.getTime();
  if (elapsedMs > MAX_DURATION_MS) {
    return { ok: false, status: 413, error: "session_too_long" };
  }
  if (session.sizeBytes + chunkSize > MAX_SIZE_BYTES) {
    return { ok: false, status: 413, error: "session_size_exceeded" };
  }
  if (session.eventCount + chunkEventCount > MAX_EVENT_COUNT) {
    return { ok: false, status: 413, error: "session_events_exceeded" };
  }

  // Persist bytes. The local storage adapter's only error mode is disk
  // full; let it throw and the route returns 500 (provider retry safe).
  const storageKey = newStorageKey("events.json");
  await putBytes({ key: storageKey, bytes: json, contentType: "application/x-rrweb-events+json" });

  // Insert chunk row; collisions on (session_id, sequence) return a
  // unique-violation error which the route maps to 409.
  let chunkId: string;
  try {
    const [chunk] = await db.insert(replayChunks).values({
      sessionId: session.id,
      sequence: input.sequence,
      storageKey,
      sizeBytes: chunkSize,
      eventCount: chunkEventCount,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
    }).returning({ id: replayChunks.id });
    chunkId = chunk.id;
  } catch (err) {
    if (String(err).includes("replay_chunks_seq_unique")) {
      return { ok: false, status: 409, error: "duplicate_sequence" };
    }
    throw err;
  }

  // Update running totals + ended_at. SQL increment so concurrent chunks
  // from the same session (unlikely but possible) don't lose writes.
  await db
    .update(replaySessions)
    .set({
      eventCount: sql`${replaySessions.eventCount} + ${chunkEventCount}`,
      sizeBytes:  sql`${replaySessions.sizeBytes}  + ${chunkSize}`,
      endedAt:    input.endedAt,
    })
    .where(eq(replaySessions.id, session.id));

  return { ok: true, sessionId: session.id, chunkId, capped: false };
}

// Exported for the unit test + the chunk caps card in settings UI.
export const REPLAY_CAPS = {
  maxSizeBytes: MAX_SIZE_BYTES,
  maxEventCount: MAX_EVENT_COUNT,
  maxDurationMs: MAX_DURATION_MS,
} as const;
