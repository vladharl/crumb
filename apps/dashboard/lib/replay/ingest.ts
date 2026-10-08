import "server-only";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db, replaySessions, replayChunks, workspaces, type Item, type Workspace } from "@crumb/db";
import { deleteBytes, newStorageKey, putBytes } from "@/lib/storage";
import { hasFeature } from "@/lib/entitlements";
import { checkReplayBytesCap, incrementUsage } from "@/lib/usage";
import { parseUserAgent } from "@/lib/replay/ua";

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
  screenW?: number | null;
  screenH?: number | null;
  // Derived server-side from the request (never trusted from the body).
  callerIp?: string | null;
  geoCountry?: string | null;
  geoCity?: string | null;
};

export type ChunkResult =
  | { ok: true; sessionId: string; chunkId: string; capped: false }
  | { ok: false; status: number; error: string };

// Resolve or create the replay_sessions row from the (workspaceSlug,
// sessionToken) pair. The token is high-entropy (16 bytes) so the lookup
// is effectively the auth check on this endpoint — there's no JWT at
// session-start time. A token another workspace already holds is refused.
export async function recordChunk(input: ChunkInput): Promise<ChunkResult> {
  if (!input.sessionToken || input.sessionToken.length > 64) {
    return { ok: false, status: 400, error: "bad_token" };
  }
  if (!Array.isArray(input.events) || input.events.length === 0) {
    return { ok: false, status: 400, error: "empty_events" };
  }

  const [ws] = await db
    .select({
      id: workspaces.id,
      sessionRecordEnabled: workspaces.sessionRecordEnabled,
      planId: workspaces.planId,
      subscriptionStatus: workspaces.subscriptionStatus,
    })
    .from(workspaces)
    .where(eq(workspaces.slug, input.workspaceSlug))
    .limit(1);
  if (!ws) return { ok: false, status: 404, error: "workspace_not_found" };
  // Plan entitlement first (cloud + paid plan), then the per-workspace toggle.
  if (!hasFeature(ws, "session_record")) return { ok: false, status: 403, error: "session_record_not_entitled" };
  if (!ws.sessionRecordEnabled) return { ok: false, status: 403, error: "session_record_disabled" };

  // Serialize the chunk early so we know the byte size for cap accounting.
  const json = Buffer.from(JSON.stringify(input.events));
  const chunkSize = json.byteLength;
  const chunkEventCount = input.events.length;

  // Find-or-create the session row.
  const findSession = () => db
    .select({
      id: replaySessions.id,
      startedAt: replaySessions.startedAt,
      endedAt: replaySessions.endedAt,
      eventCount: replaySessions.eventCount,
      sizeBytes: replaySessions.sizeBytes,
    })
    .from(replaySessions)
    .where(and(
      eq(replaySessions.workspaceId, ws.id),
      eq(replaySessions.sessionToken, input.sessionToken),
    ))
    .limit(1)
    .then(rows => rows[0]);
  let session = await findSession();

  if (!session || session.eventCount === 0) {
    // The session's first chunk. Enrich once: parse the UA into
    // device/browser/os and stamp the request-derived IP + geo. Later chunks
    // don't touch these. A submit that got here first already made the row,
    // linked to its item (linkReplaySession): fill it in, keep the link.
    const ua = parseUserAgent(input.userAgent);
    const firstChunk = {
      startedAt: input.startedAt,
      pageUrl: input.pageUrl ?? null,
      userAgent: input.userAgent ?? null,
      viewportW: input.viewportW ?? null,
      viewportH: input.viewportH ?? null,
      screenW: input.screenW ?? null,
      screenH: input.screenH ?? null,
      callerIp: input.callerIp ?? null,
      geoCountry: input.geoCountry ?? null,
      geoCity: input.geoCity ?? null,
      deviceType: ua.deviceType,
      browserName: ua.browserName,
      browserVersion: ua.browserVersion,
      osName: ua.osName,
      osVersion: ua.osVersion,
    };
    await db.insert(replaySessions)
      .values({ workspaceId: ws.id, sessionToken: input.sessionToken, ...firstChunk })
      .onConflictDoUpdate({
        target: replaySessions.sessionToken,
        set: firstChunk,
        setWhere: and(eq(replaySessions.workspaceId, ws.id), eq(replaySessions.eventCount, 0)),
      });
    session = await findSession();
    if (!session) return { ok: false, status: 403, error: "session_token_taken" };
  }

  // Cap enforcement against running totals. Duration spans the whole session
  // in whatever order its chunks land: the widget's pre-consent buffer is the
  // oldest chunk and the biggest, so it can arrive after a newer one.
  const sessionStart = Math.min(session.startedAt.getTime(), input.startedAt.getTime());
  const sessionEnd = Math.max(session.endedAt?.getTime() ?? 0, input.endedAt.getTime());
  if (sessionEnd - sessionStart > MAX_DURATION_MS) {
    return { ok: false, status: 413, error: "session_too_long" };
  }
  if (session.sizeBytes + chunkSize > MAX_SIZE_BYTES) {
    return { ok: false, status: 413, error: "session_size_exceeded" };
  }
  if (session.eventCount + chunkEventCount > MAX_EVENT_COUNT) {
    return { ok: false, status: 413, error: "session_events_exceeded" };
  }

  // Monthly per-workspace storage cap — bounds total replay cost on top of
  // the per-session hard caps above. 429 (not 413) signals a quota, not a
  // malformed/oversized single session.
  const monthly = await checkReplayBytesCap(ws, chunkSize);
  if (!monthly.allowed) {
    return { ok: false, status: 429, error: "replay_monthly_quota_exceeded" };
  }

  // Persist bytes. The local storage adapter's only error mode is disk
  // full; let it throw and the route returns 500 (provider retry safe).
  const storageKey = newStorageKey("events.json");
  await putBytes({ key: storageKey, bytes: json, contentType: "application/x-rrweb-events+json" });

  // Insert chunk row; a sequence the session already has (a retried upload)
  // is a 409, and its bytes go back out.
  const [chunk] = await db.insert(replayChunks).values({
    sessionId: session.id,
    sequence: input.sequence,
    storageKey,
    sizeBytes: chunkSize,
    eventCount: chunkEventCount,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  }).onConflictDoNothing().returning({ id: replayChunks.id });
  if (!chunk) {
    await deleteBytes(storageKey).catch(() => {});
    return { ok: false, status: 409, error: "duplicate_sequence" };
  }
  const chunkId = chunk.id;

  // Update running totals + the session's span. SQL so concurrent chunks
  // from the same session don't lose writes, and an older chunk landing
  // late still moves the start back.
  await db
    .update(replaySessions)
    .set({
      eventCount: sql`${replaySessions.eventCount} + ${chunkEventCount}`,
      sizeBytes:  sql`${replaySessions.sizeBytes}  + ${chunkSize}`,
      startedAt:  sql`LEAST(${replaySessions.startedAt}, ${input.startedAt.toISOString()}::timestamptz)`,
      endedAt:    sql`GREATEST(${replaySessions.endedAt}, ${input.endedAt.toISOString()}::timestamptz)`,
    })
    .where(eq(replaySessions.id, session.id));

  // Meter the bytes for the monthly cap. After the write so we never charge
  // for a chunk we failed to persist.
  await incrementUsage(ws.id, "replay_bytes", chunkSize);

  return { ok: true, sessionId: session.id, chunkId, capped: false };
}

// Link the customer's recording to the item they submitted with its token.
// The submit can beat the recorder's first chunk here (consent and submit can
// be seconds apart, and the pre-consent buffer is a big upload), so with no
// row yet this makes one, linked, and the chunks append to it as they land.
// Never takes a token another workspace holds, another customer's recording,
// or one already linked to an earlier item. Returns whether it linked.
export async function linkReplaySession(
  ws: Pick<Workspace, "id" | "planId" | "subscriptionStatus" | "sessionRecordEnabled">,
  item: Pick<Item, "id" | "submitterId" | "createdAt">,
  sessionToken: string,
): Promise<boolean> {
  if (!hasFeature(ws, "session_record") || !ws.sessionRecordEnabled) return false;
  const linked = await db.insert(replaySessions)
    .values({
      workspaceId: ws.id,
      sessionToken,
      itemId: item.id,
      accountUserId: item.submitterId,
      // Until its first chunk says when recording began; a session can't
      // start after the item it came in with.
      startedAt: item.createdAt,
    })
    .onConflictDoUpdate({
      target: replaySessions.sessionToken,
      set: { itemId: item.id, accountUserId: item.submitterId },
      setWhere: and(
        eq(replaySessions.workspaceId, ws.id),
        isNull(replaySessions.itemId),
        or(isNull(replaySessions.accountUserId), eq(replaySessions.accountUserId, item.submitterId)),
      ),
    })
    .returning({ id: replaySessions.id });
  return linked.length > 0;
}

// Exported for the unit test + the chunk caps card in settings UI.
export const REPLAY_CAPS = {
  maxSizeBytes: MAX_SIZE_BYTES,
  maxEventCount: MAX_EVENT_COUNT,
  maxDurationMs: MAX_DURATION_MS,
} as const;
