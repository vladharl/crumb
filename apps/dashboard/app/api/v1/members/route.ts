import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, accountUsers, items } from "@crumb/db";
import { cors, fail, preflight, resolveCustomer, type CustomerCtx } from "@/lib/public-api";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

// Resolve the caller and assert they're an admin of their account. Returns the
// ctx on success or a ready-to-return error Response.
async function requireAdmin(
  req: Request,
  body: { workspace_slug?: string; account_user_email?: string },
): Promise<{ ctx: CustomerCtx } | { res: Response }> {
  const r = await resolveCustomer(req, {
    workspaceSlug: body.workspace_slug ?? null,
    email: body.account_user_email ?? null,
  });
  if (!r.ok) return { res: fail(r.status, r.error) };
  if (r.ctx.user.role !== "admin") return { res: fail(403, "not_account_admin") };
  return { ctx: r.ctx };
}

// Load a target member, scoped to the caller's workspace + account so an admin
// can only touch their own account's users.
async function loadTarget(ctx: CustomerCtx, targetId: string) {
  const [t] = await db
    .select()
    .from(accountUsers)
    .where(and(
      eq(accountUsers.id, targetId),
      eq(accountUsers.workspaceId, ctx.workspace.id),
      eq(accountUsers.accountId, ctx.user.accountId),
    ))
    .limit(1);
  return t ?? null;
}

async function adminCount(ctx: CustomerCtx): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(accountUsers)
    .where(and(eq(accountUsers.accountId, ctx.user.accountId), eq(accountUsers.role, "admin")));
  return n ?? 0;
}

// PATCH /api/v1/members → change a member's role (admin | member).
export async function PATCH(req: Request) {
  const rl = await checkRateLimitAsync(`members:${callerIpFromRequest(req)}`, { capacity: 60, refillPerSec: 1 });
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let body: { workspace_slug?: string; account_user_email?: string; target_user_id?: string; role?: string };
  try { body = await req.json(); } catch { return fail(400, "invalid_json"); }
  if (typeof body.target_user_id !== "string" || (body.role !== "admin" && body.role !== "member")) {
    return fail(400, "invalid_request");
  }

  const auth = await requireAdmin(req, body);
  if ("res" in auth) return auth.res;
  const { ctx } = auth;

  const target = await loadTarget(ctx, body.target_user_id);
  if (!target) return fail(404, "member_not_found");
  if (target.role === body.role) return cors(NextResponse.json({ ok: true, role: target.role }));

  // Don't let the account demote its last admin into a state with no admins.
  if (target.role === "admin" && body.role === "member" && (await adminCount(ctx)) <= 1) {
    return fail(409, "last_admin");
  }

  await db.update(accountUsers).set({ role: body.role }).where(eq(accountUsers.id, target.id));
  return cors(NextResponse.json({ ok: true, role: body.role }));
}

// DELETE /api/v1/members → remove a member from the account.
// Guards: not yourself, not the last admin, and not a user who has feedback on
// file (items.submitter_id is ON DELETE RESTRICT — their feedback must persist).
export async function DELETE(req: Request) {
  const rl = await checkRateLimitAsync(`members:${callerIpFromRequest(req)}`, { capacity: 60, refillPerSec: 1 });
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let body: { workspace_slug?: string; account_user_email?: string; target_user_id?: string };
  try { body = await req.json(); } catch { return fail(400, "invalid_json"); }
  if (typeof body.target_user_id !== "string") return fail(400, "invalid_request");

  const auth = await requireAdmin(req, body);
  if ("res" in auth) return auth.res;
  const { ctx } = auth;

  if (body.target_user_id === ctx.user.id) return fail(409, "cannot_remove_self");

  const target = await loadTarget(ctx, body.target_user_id);
  if (!target) return fail(404, "member_not_found");
  if (target.role === "admin" && (await adminCount(ctx)) <= 1) return fail(409, "last_admin");

  // Anyone who has submitted feedback can't be hard-deleted (FK restrict keeps
  // their items intact). Surface a clear reason instead of a 500.
  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(items)
    .where(eq(items.submitterId, target.id));
  if ((n ?? 0) > 0) return fail(409, "has_items");

  await db.delete(accountUsers).where(eq(accountUsers.id, target.id));
  return cors(NextResponse.json({ ok: true, removed: target.id }));
}
