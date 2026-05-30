import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, accountUsers } from "@crumb/db";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

// POST /api/v1/notifications → update the calling customer's email prefs.
// Identity resolved like the rest of the public API (JWT on Cloud,
// workspace+email on self-host). Partial: only the booleans present are saved.
export async function POST(req: Request) {
  const rl = await checkRateLimitAsync(`notif:${callerIpFromRequest(req)}`, { capacity: 60, refillPerSec: 1 });
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let body: {
    workspace_slug?: string;
    account_user_email?: string;
    replies?: boolean;
    status?: boolean;
    roadmap?: boolean;
    unsubscribed_all?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid_json");
  }

  const r = await resolveCustomer(req, {
    workspaceSlug: body.workspace_slug ?? null,
    email: body.account_user_email ?? null,
  });
  if (!r.ok) return fail(r.status, r.error);

  const patch: Partial<{
    notifyReplies: boolean;
    notifyStatus: boolean;
    notifyRoadmap: boolean;
    unsubscribedAll: boolean;
  }> = {};
  if (typeof body.replies === "boolean") patch.notifyReplies = body.replies;
  if (typeof body.status === "boolean") patch.notifyStatus = body.status;
  if (typeof body.roadmap === "boolean") patch.notifyRoadmap = body.roadmap;
  if (typeof body.unsubscribed_all === "boolean") patch.unsubscribedAll = body.unsubscribed_all;
  if (Object.keys(patch).length === 0) return fail(400, "no_fields");

  const [updated] = await db
    .update(accountUsers)
    .set(patch)
    .where(eq(accountUsers.id, r.ctx.user.id))
    .returning({
      replies: accountUsers.notifyReplies,
      status: accountUsers.notifyStatus,
      roadmap: accountUsers.notifyRoadmap,
      unsubscribed_all: accountUsers.unsubscribedAll,
    });

  return cors(NextResponse.json({ ok: true, notifications: updated }));
}
