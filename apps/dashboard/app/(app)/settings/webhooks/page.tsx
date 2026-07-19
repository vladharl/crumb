import { Card, CardHead, Pill } from "@crumb/ui";
import { desc, eq } from "drizzle-orm";
import { db, webhookEndpoints } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { WebhooksPanel, type EndpointView } from "./WebhooksPanel";

export const dynamic = "force-dynamic";

export default async function WebhooksPage() {
  const { workspace, user } = await getActiveSession();
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.workspaceId, workspace.id))
    .orderBy(desc(webhookEndpoints.createdAt));

  const initial: EndpointView[] = rows.map(r => ({
    id: r.id,
    url: r.url,
    active: r.active,
    events: r.events,
    lastStatus: r.lastStatus,
    lastAttemptAt: r.lastAttemptAt ? r.lastAttemptAt.toISOString() : null,
    failureCount: r.failureCount,
  }));

  return (
    <>
      <Card>
        <CardHead title="Outbound webhooks" after={<Pill ring>{rows.length} endpoint{rows.length === 1 ? "" : "s"}</Pill>} />
        <div className="card-body col gap-4">
          <p className="text-sm muted note">
            Get a signed POST to your own services whenever something happens to a feedback item: created, status changed, replied to, assigned, or merged. Drive your own automations (notify a channel, update a dashboard, kick off a deploy). Pick the events each endpoint receives; each signs payloads with its own secret.
          </p>
          <WebhooksPanel initial={initial} isAdmin={user.role === "admin"} />
        </div>
      </Card>

      <Card>
        <CardHead title="Payload & verification" />
        <div className="card-body col gap-3">
          <p className="text-sm muted note">
            We POST JSON with an <span className="mono">X-Crumb-Signature: sha256=&lt;hex&gt;</span> header, an HMAC-SHA256 of the raw body keyed by the endpoint secret. Recompute it and compare (constant-time) to verify the request came from Crumb.
          </p>
          <p className="text-sm muted note">
            The <span className="mono">X-Crumb-Event</span> header and the body's <span className="mono">type</span> name the event. Possible types: <span className="mono">item.created</span>, <span className="mono">item.status_changed</span>, <span className="mono">item.reply_created</span>, <span className="mono">item.assigned</span>, <span className="mono">item.merged</span>. Internal notes are never delivered.
          </p>
          <div className="code">
{`POST /your/endpoint
X-Crumb-Event: item.status_changed
X-Crumb-Signature: sha256=…

{
  "type": "item.status_changed",
  "workspace": "${workspace.slug}",
  "item": { "short_id": "FB-42", "title": "…", "type": "bug" },
  "from_status": "open",
  "to_status": "planned",
  "reason": null,
  "at": "2026-01-01T12:00:00.000Z"
}`}
          </div>
          <div className="code">
{`// Node verification
import { createHmac, timingSafeEqual } from "node:crypto";
const expected = "sha256=" + createHmac("sha256", SECRET).update(rawBody).digest("hex");
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-crumb-signature"]));`}
          </div>
          <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
            Delivery is best-effort with a 5s timeout. An endpoint that fails repeatedly is auto-paused; re-enable it here once it's healthy.
          </p>
        </div>
      </Card>
    </>
  );
}
