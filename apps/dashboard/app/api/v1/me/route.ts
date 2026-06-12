import { NextResponse } from "next/server";
import { db, accounts, accountUsers, items, initiatives } from "@crumb/db";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { hasFeature, usageAnalyticsAllowed } from "@/lib/entitlements";
import { emailConfigured } from "@/lib/email";

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

  // Does this workspace have a public roadmap? Drives the widget's Roadmap tab.
  const [{ count: roadmapCount }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(initiatives)
    .where(and(
      eq(initiatives.workspaceId, workspace.id),
      eq(initiatives.isPublic, true),
      isNotNull(initiatives.roadmapColumn),
    ));

  // Customer notification settings are only meaningful when the deployment can
  // actually send email — the widget hides the whole view when this is false.
  const emailEnabled = emailConfigured();

  return cors(NextResponse.json({
    has_roadmap: (roadmapCount ?? 0) > 0,
    email_enabled: emailEnabled,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      initials: user.initials,
      role: user.role,
    },
    notifications: {
      replies: user.notifyReplies,
      status: user.notifyStatus,
      roadmap: user.notifyRoadmap,
      unsubscribed_all: user.unsubscribedAll,
    },
    workspace: {
      slug: workspace.slug,
      name: workspace.name,
      accent: workspace.accent,
      launcher_bg: workspace.launcherBg,
      launcher_edge: workspace.launcherEdge ?? "right",
      launcher_visibility: workspace.launcherVisibility ?? "auto",
      launcher_offset_y: workspace.launcherOffsetY ?? 0,
      // Only advertise recording to the widget when the workspace both
      // toggled it on AND its plan entitles it — otherwise the recorder
      // bundle would load and every chunk POST would 403.
      session_record_enabled: (workspace.sessionRecordEnabled ?? false) && hasFeature(workspace, "session_record"),
      // Tells the widget whether to ship crumb.track() events. Capability-gated:
      // on (self-host) or requires the usage_analytics plan feature (Cloud).
      usage_tracking_enabled: usageAnalyticsAllowed(workspace),
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
