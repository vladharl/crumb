import { NextResponse } from "next/server";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { db, items, workspaces } from "@crumb/db";
import { verifyWebhook, verifyWebhookToken } from "@/lib/integrations/jira";
import { isCloud } from "@/lib/tier";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { log } from "@/lib/log";
import { syncExternalStatus } from "@/lib/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Jira webhook. Status sync only — when a linked Issue's status changes,
// update the matching item's external_status (and emit
// item.external_status_changed).
//
// Atlassian fires `jira:issue_updated` on any field change. We filter to
// status changes by inspecting the `changelog.items` array for an entry
// whose `field` is "status".
//
// Project keys repeat across Jira sites, so every delivery is scoped:
//  - The webhook each Cloud install registers (ensureWebhook in
//    lib/integrations/jira.ts) posts to ?ws=<workspaceId>&t=<token>. A valid
//    token limits the update to that workspace's items.
//  - A manual admin webhook signed with the deployment-wide
//    JIRA_WEBHOOK_SECRET (self-host) is scoped to the workspace(s) connected
//    to the site the event came from: the origin of `issue.self`, which is the
//    same site URL stored as jiraSiteUrl at connect / token refresh. Cloud
//    refuses it: every tenant would need that secret, and with it could sign
//    an event naming another tenant's site.

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
  const raw = await req.text();
  const params = new URL(req.url).searchParams;
  const workspaceId = params.get("ws");
  const authed = workspaceId !== null
    ? verifyWebhookToken(workspaceId, params.get("t"))
    : !isCloud() && verifyWebhook(raw, req.headers.get("x-hub-signature"));
  if (!authed) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }
  // Rate-limit after auth, per workspace: every tenant's deliveries arrive from
  // Atlassian's shared egress IPs, so an IP key would let one tenant starve others.
  const rl = await checkRateLimitAsync(`jira-webhook:${workspaceId ?? callerIpFromRequest(req)}`);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

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
  if (!key) return NextResponse.json({ received: true });
  let scope: SQL;
  if (workspaceId !== null) {
    scope = eq(items.workspaceId, workspaceId);
  } else {
    const self = event.issue?.self;
    if (!self || !URL.canParse(self)) return NextResponse.json({ received: true });
    scope = inArray(items.workspaceId, db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.jiraSiteUrl, new URL(self).origin)));
  }

  // Pull the new status either from the changelog (preferred — it has the
  // actual transition) or fall back to issue.fields.status.name.
  const statusChange = event.changelog?.items.find(i => i.field === "status");
  const newStatus = statusChange?.toString ?? event.issue?.fields?.status?.name ?? null;

  try {
    await syncExternalStatus(and(
      scope,
      eq(items.externalProvider, "jira"),
      eq(items.externalTicketId, key),
    ), newStatus);
  } catch (err) {
    log.error("jira webhook DB update failed", { scope: "crumb/jira", key, err });
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
