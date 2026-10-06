import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, items, workspaces } from "@crumb/db";
import { verifyWebhook } from "@/lib/integrations/jira";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Jira webhook. Status sync only — when a linked Issue's status changes,
// update the matching item's external_status.
//
// Atlassian fires `jira:issue_updated` on any field change. We filter to
// status changes by inspecting the `changelog.items` array for an entry
// whose `field` is "status".
//
// Project keys repeat across Jira sites and the signing secret is
// deployment-wide, so updates are scoped to the workspace(s) connected to
// the site the event came from: the origin of `issue.self`, which is the
// same site URL stored as jiraSiteUrl at connect / token refresh.

type JiraWebhookEvent = {
  webhookEvent: string;
  issue?: {
    key: string;
    self?: string; // "https://<site>.atlassian.net/rest/api/2/issue/10002"
    fields?: { status?: { name?: string } };
  };
  changelog?: {
    items: Array<{ field: string; toString?: string | null }>;
  };
};

export async function POST(req: Request) {
  const rl = await checkRateLimitAsync(`jira-webhook:${callerIpFromRequest(req)}`);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature");
  if (!verifyWebhook(raw, sig)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  let event: JiraWebhookEvent;
  try {
    event = JSON.parse(raw) as JiraWebhookEvent;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (event.webhookEvent !== "jira:issue_updated") {
    return NextResponse.json({ received: true });
  }

  const key = event.issue?.key;
  const self = event.issue?.self;
  if (!key || !self || !URL.canParse(self)) return NextResponse.json({ received: true });
  const siteUrl = new URL(self).origin;

  // Pull the new status either from the changelog (preferred — it has the
  // actual transition) or fall back to issue.fields.status.name.
  const statusChange = event.changelog?.items.find(i => i.field === "status");
  const newStatus = statusChange?.toString ?? event.issue?.fields?.status?.name ?? null;

  try {
    await db
      .update(items)
      .set({
        externalStatus: newStatus,
        externalSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        inArray(items.workspaceId, db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.jiraSiteUrl, siteUrl))),
        eq(items.externalProvider, "jira"),
        eq(items.externalTicketId, key),
      ));
  } catch (err) {
    log.error("jira webhook DB update failed", { scope: "crumb/jira", key, err });
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
