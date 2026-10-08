import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, items, workspaces } from "@crumb/db";
import { resolveOrganizationIds, verifyWebhook } from "@/lib/integrations/linear";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Linear webhook ingress. Status sync only — when a linked Issue's state
// changes, we update the matching item's external_status. Linear is the
// source of truth for engineering status; Crumb never writes back.
//
// Linear sends a header `linear-signature` containing a hex SHA-256 HMAC
// of the raw request body, signed with the webhook's signing secret.
// LINEAR_WEBHOOK_SECRET in env must match what was configured at the
// Linear app's Webhooks page.
//
// Event shape we care about (Issue update):
//   {
//     "action": "update",
//     "type": "Issue",
//     "data": { "id": "<uuid>", "identifier": "ENG-42", "state": { "name": "In Progress" }, "url": "..." },
//     "updatedFrom": { "stateId": "..." },  // present when state changed
//     "organizationId": "<uuid>"            // the Linear org that sent it
//   }
//
// The signing secret is deployment-wide (on Cloud every org's events share
// it) and identifiers like ENG-42 repeat across orgs, so updates are scoped
// to the workspace(s) whose install belongs to `organizationId`.
//
// Other event types (Comment, Project, etc.) return 200 ok — we never
// trigger Linear retries for events we don't model.

type LinearWebhookEvent = {
  action: string;
  type: string;
  organizationId?: string;
  data: {
    id: string;
    identifier?: string;
    url?: string;
    state?: { name?: string } | null;
  };
  updatedFrom?: Record<string, unknown>;
};

export async function POST(req: Request) {
  const rl = await checkRateLimitAsync(`linear-webhook:${callerIpFromRequest(req)}`);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  // Stripe-style: read raw body for HMAC, then JSON-parse separately.
  const raw = await req.text();
  const sig = req.headers.get("linear-signature");
  if (!verifyWebhook(raw, sig)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  let event: LinearWebhookEvent;
  try {
    event = JSON.parse(raw) as LinearWebhookEvent;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Only Issue updates trigger a sync; everything else gets a 200 ok so
  // Linear stops retrying.
  if (event.type !== "Issue" || event.action !== "update") {
    return NextResponse.json({ received: true });
  }

  const identifier = event.data.identifier;
  const organizationId = event.organizationId;
  if (!identifier || !organizationId) return NextResponse.json({ received: true });

  const newStatus = event.data.state?.name ?? null;

  try {
    await resolveOrganizationIds();
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
          .where(eq(workspaces.linearOrganizationId, organizationId))),
        eq(items.externalProvider, "linear"),
        eq(items.externalTicketId, identifier),
      ));
  } catch (err) {
    log.error("linear webhook DB update failed", { scope: "crumb/linear", identifier, err });
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
