import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, initiatives, roadmapFollows } from "@crumb/db";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { listPublicRoadmap, onPublicRoadmapSql, type RoadmapLane } from "@/lib/roadmap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public roadmap for the embed widget. Identity (JWT on Cloud, workspace+email
// on self-host) is resolved so we can mark which items the caller follows and
// attribute follow/unfollow writes.

export function OPTIONS() {
  return preflight();
}

// GET /api/v1/roadmap[?workspace&email] → public initiatives grouped Now/Next/Later,
// plus the most recently shipped.
export async function GET(req: Request) {
  const rl = await checkRateLimitAsync(`roadmap:${callerIpFromRequest(req)}`, { capacity: 120, refillPerSec: 2 });
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const url = new URL(req.url);
  const r = await resolveCustomer(req, {
    workspaceSlug: url.searchParams.get("workspace"),
    email: url.searchParams.get("email"),
  });
  if (!r.ok) return fail(r.status, r.error);

  const [entries, follows] = await Promise.all([
    listPublicRoadmap(r.ctx.workspace.id),
    db
      .select({ initiativeId: roadmapFollows.initiativeId })
      .from(roadmapFollows)
      .where(eq(roadmapFollows.accountUserId, r.ctx.user.id)),
  ]);
  const followed = new Set(follows.map(f => f.initiativeId));

  const columns: Record<RoadmapLane, unknown[]> = { now: [], next: [], later: [], shipped: [] };
  for (const it of entries) {
    columns[it.lane].push({
      id: it.id,
      short_id: it.shortId,
      name: it.name,
      description: it.description,
      status: it.status,
      lane: it.lane,
      shipped_at: it.shippedAt,
      following: followed.has(it.id),
    });
  }

  return cors(NextResponse.json({ columns }));
}

// POST /api/v1/roadmap → follow/unfollow an initiative.
export async function POST(req: Request) {
  const rl = await checkRateLimitAsync(`roadmap:${callerIpFromRequest(req)}`, { capacity: 120, refillPerSec: 2 });
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let body: { workspace_slug?: string; account_user_email?: string; initiative_id?: string; follow?: boolean };
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid_json");
  }
  if (typeof body.initiative_id !== "string" || typeof body.follow !== "boolean") {
    return fail(400, "invalid_request");
  }

  const r = await resolveCustomer(req, {
    workspaceSlug: body.workspace_slug ?? null,
    email: body.account_user_email ?? null,
  });
  if (!r.ok) return fail(r.status, r.error);

  // The initiative must belong to this workspace and be on its public roadmap.
  const [init] = await db
    .select({ id: initiatives.id })
    .from(initiatives)
    .where(and(
      eq(initiatives.id, body.initiative_id),
      eq(initiatives.workspaceId, r.ctx.workspace.id),
      onPublicRoadmapSql(),
    ))
    .limit(1);
  if (!init) return fail(404, "initiative_not_found");

  if (body.follow) {
    await db
      .insert(roadmapFollows)
      .values({ workspaceId: r.ctx.workspace.id, initiativeId: init.id, accountUserId: r.ctx.user.id })
      .onConflictDoNothing();
  } else {
    await db
      .delete(roadmapFollows)
      .where(and(eq(roadmapFollows.initiativeId, init.id), eq(roadmapFollows.accountUserId, r.ctx.user.id)));
  }

  return cors(NextResponse.json({ ok: true, following: body.follow }));
}
