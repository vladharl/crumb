import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, items } from "@crumb/db";
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

type JiraWebhookEvent = {
  webhookEvent: string;
  issue?: {
    key: string;
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
  if (!key) return NextResponse.json({ received: true });

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
        eq(items.externalProvider, "jira"),
        eq(items.externalTicketId, key),
      ));
  } catch (err) {
    log.error("jira webhook DB update failed", { scope: "crumb/jira", key, err });
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
