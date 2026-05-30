import { NextResponse } from "next/server";
import { cors, fail, preflight } from "@/lib/public-api";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { isCloud } from "@/lib/tier";
import { recordChunk } from "@/lib/replay/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public endpoint hit by the widget's rrweb recorder. Cloud-only at the
// product layer (returns 410 on self-host). Auth is the session_token
// itself — 128 bits of entropy issued by the widget on first paint.

export function OPTIONS() {
  return preflight();
}

type ChunkBody = {
  workspace_slug?: string;
  sequence?: number;
  started_at?: string;
  ended_at?: string;
  page_url?: string;
  user_agent?: string;
  viewport_w?: number;
  viewport_h?: number;
  events?: unknown[];
};

// The URL slot is named [id] (not [token]) because Next requires a single
// slug name per path depth: the sibling vendor-side reads under
// `/replay-sessions/[id]/...` already claim it. Semantically the value
// is the widget's 32-hex session_token, not a UUID — we keep the variable
// name explicit below to avoid confusion.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const sessionToken = params.id;
  if (!isCloud()) {
    return fail(410, "session_record_cloud_only");
  }

  const rl = await checkRateLimitAsync(`replay:${callerIpFromRequest(req)}`, { capacity: 120, refillPerSec: 2 });
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let payload: ChunkBody;
  try {
    payload = await req.json();
  } catch {
    return fail(400, "invalid_json");
  }

  const sequence = typeof payload.sequence === "number" ? payload.sequence : null;
  if (sequence === null || sequence < 0) return fail(400, "bad_sequence");
  if (!payload.workspace_slug) return fail(400, "missing_workspace_slug");
  if (!payload.started_at || !payload.ended_at) return fail(400, "missing_timing");
  if (!Array.isArray(payload.events)) return fail(400, "missing_events");

  const startedAt = new Date(payload.started_at);
  const endedAt = new Date(payload.ended_at);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    return fail(400, "bad_timing");
  }

  // Per-workspace ingest cap. `workspace_slug` is attacker-controlled, so
  // the per-IP limit above doesn't bound the storage a *distributed*
  // attacker can pile onto a single target workspace. Bucketing on the
  // slug caps the chunk-write rate per target regardless of source IP.
  // Generous ceiling (20/sec sustained, 600 burst) so a busy SaaS with
  // many concurrent customer sessions isn't throttled in normal use.
  // NOTE: this bounds *rate*, not cumulative bytes — a persistent
  // per-workspace daily byte-quota (DB-backed) is the complete fix and
  // is still deferred (see Phase 10 risks). Keyed on slug because that's
  // the identifier the caller supplies before we resolve the workspace.
  const wsRl = await checkRateLimitAsync(`replay:ws:${payload.workspace_slug}`, { capacity: 600, refillPerSec: 20 });
  if (!wsRl.ok) return tooManyRequests(wsRl.retryAfterSeconds);

  const r = await recordChunk({
    sessionToken,
    workspaceSlug: payload.workspace_slug,
    sequence,
    startedAt,
    endedAt,
    events: payload.events,
    pageUrl: payload.page_url ?? null,
    userAgent: payload.user_agent ?? null,
    viewportW: payload.viewport_w ?? null,
    viewportH: payload.viewport_h ?? null,
  });

  if (!r.ok) return fail(r.status, r.error);

  return cors(NextResponse.json({
    session_id: r.sessionId,
    chunk_id: r.chunkId,
  }, { status: 201 }));
}
