import { NextResponse } from "next/server";
import { db, accounts, accountUsers, items } from "@crumb/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

// ─── GET /api/v1/me?workspace=&email= ─────────────────────────
// Returns the calling customer-user's identity + their account.
// If they're an admin of that account, also returns the members list
// (which is what powers the widget's Admin tab).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const r = await resolveCustomer(req, {
    workspaceSlug: url.searchParams.get("workspace"),
    email: url.searchParams.get("email"),
  });
  if (!r.ok) return fail(r.status, r.error);

  const { workspace, user } = r.ctx;

  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspace.id), eq(accounts.id, user.accountId)))
    .limit(1);
  if (!account) return fail(404, "account_not_found");

  const isAdmin = user.role === "admin";

  // Members are only meaningful for admins; non-admins get a count.
  let members: Array<{ id: string; name: string; email: string; initials: string; role: string; item_count: number }> = [];
  let memberCount = 0;

  if (isAdmin) {
    const rows = await db
      .select({
        id: accountUsers.id,
        name: accountUsers.name,
        email: accountUsers.email,
        initials: accountUsers.initials,
        role: accountUsers.role,
        itemCount: sql<number>`COUNT(${items.id})::int`,
      })
      .from(accountUsers)
      .leftJoin(items, eq(items.submitterId, accountUsers.id))
      .where(eq(accountUsers.accountId, account.id))
      .groupBy(accountUsers.id)
      .orderBy(asc(accountUsers.name));
    members = rows.map(m => ({
      id: m.id,
      name: m.name,
      email: m.email,
      initials: m.initials,
      role: m.role,
      item_count: m.itemCount,
    }));
    memberCount = members.length;
  } else {
    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(accountUsers)
      .where(eq(accountUsers.accountId, account.id));
    memberCount = count ?? 0;
  }

  return cors(NextResponse.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      initials: user.initials,
      role: user.role,
    },
    workspace: {
      slug: workspace.slug,
      name: workspace.name,
      accent: workspace.accent,
      launcher_bg: workspace.launcherBg,
      position: workspace.position,
      session_record_enabled: workspace.sessionRecordEnabled ?? false,
    },
    account: {
      id: account.id,
      name: account.name,
      member_count: memberCount,
    },
    is_account_admin: isAdmin,
    members,
  }));
}
