import { NextResponse } from "next/server";
import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, items, workspaces } from "@crumb/db";
import { verifyWebhook } from "@/lib/integrations/linear";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { log } from "@/lib/log";
import { syncExternalStatus } from "@/lib/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Linear webhook ingress. Status sync only — when a linked Issue's state
// changes, we update the matching item's external_status (and emit
// item.external_status_changed). Linear is the source of truth for
// engineering status; Crumb never writes back.
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
//     "data": { "id": "<uuid>", "identifier": "ENG-42", "state": { "name": "In Progress" },
//               "url": "https://linear.app/<org url key>/issue/ENG-42/..." },
//     "updatedFrom": { "stateId": "..." },  // present when state changed
//     "organizationId": "<uuid>"            // the Linear org that sent it
//   }
//
// The signing secret is deployment-wide (on Cloud every org's events share
// it) and identifiers like ENG-42 repeat across orgs, so updates are scoped
// to the workspace(s) whose install belongs to `organizationId`, recorded by
// the OAuth callback. An install connected before the callback recorded it
// has no org id; its items match only when their own stored issue URL is in
// the org the event's issue URL names (the org's URL key). Nothing here calls
// Linear, so an expired install token never stops the sync.
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

// The org's URL key in a Linear issue URL (https://linear.app/<key>/issue/...).
function orgUrlKey(issueUrl: string | undefined): string | null {
  try {
    const url = new URL(issueUrl ?? "");
    const [key, kind] = url.pathname.split("/").filter(Boolean);
    return url.protocol === "https:" && url.hostname === "linear.app" && kind === "issue" && key ? key : null;
  } catch {
    return null;
  }
}

const installs = (where: SQL | undefined) => db.select({ id: workspaces.id }).from(workspaces).where(where);

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
  const urlKey = orgUrlKey(event.data.url);

  try {
    await syncExternalStatus(and(
      eq(items.externalProvider, "linear"),
      eq(items.externalTicketId, identifier),
      or(
        inArray(items.workspaceId, installs(eq(workspaces.linearOrganizationId, organizationId))),
        urlKey ? and(
          inArray(items.workspaceId, installs(and(isNotNull(workspaces.linearAccessToken), isNull(workspaces.linearOrganizationId)))),
          sql`starts_with(${items.externalTicketUrl}, ${`https://linear.app/${urlKey}/issue/`})`,
        ) : undefined,
      ),
    ), newStatus);
  } catch (err) {
    log.error("linear webhook DB update failed", { scope: "crumb/linear", identifier, err });
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
