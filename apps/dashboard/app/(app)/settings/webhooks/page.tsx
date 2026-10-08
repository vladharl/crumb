import { Card, CardHead, Pill } from "@crumb/ui";
import { desc, eq } from "drizzle-orm";
import { db, webhookDeliveries, webhookEndpoints } from "@crumb/db";
import { ageFrom, getActiveSession } from "@/lib/server";
import { EVENT_TYPES, EVENT_LABELS, type EventType } from "@/lib/event-catalog";
import { EVENT_DOCS, MAX_FAILURES, describeDelivery } from "@/lib/webhooks";
import { WebhooksPanel, type EndpointView } from "./WebhooksPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Webhooks · Settings" };

const LOG_ROWS = 20; // delivery-log rows shown per endpoint

// A sample body exactly as delivered: the event plus its id, in this workspace.
function sampleBody(type: EventType, slug: string): string {
  return JSON.stringify({ id: "3f2b8c1e-5a7d-4e19-b0c6-8d4f2a6e9b17", ...EVENT_DOCS[type].sample, workspace: slug }, null, 2);
}

export default async function WebhooksPage() {
  const { workspace, user } = await getActiveSession();
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.workspaceId, workspace.id))
    .orderBy(desc(webhookEndpoints.createdAt));
  // Newest attempts per endpoint (≤10 endpoints, each a bounded index scan).
  const logs = await Promise.all(rows.map(r => db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.endpointId, r.id))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(LOG_ROWS)));

  const initial: EndpointView[] = rows.map((r, i) => ({
    id: r.id,
    url: r.url,
    active: r.active,
    events: r.events,
    failureCount: r.failureCount,
    deliveries: logs[i]!.map(d => ({
      id: d.id,
      at: d.createdAt.toISOString(),
      ago: ageFrom(d.createdAt),
      event: EVENT_LABELS[d.eventType as EventType] ?? d.eventType,
      attempt: d.attempt,
      httpStatus: d.httpStatus,
      ok: d.ok,
      result: describeDelivery(d),
    })),
  }));

  return (
    <>
      <Card>
        <CardHead title="Outbound webhooks" after={<Pill ring>{rows.length} endpoint{rows.length === 1 ? "" : "s"}</Pill>} />
        <div className="card-body col gap-4">
          <p className="text-sm muted note">
            Get a signed POST to your own services when feedback moves: items created, status changes, replies, tracker updates, customer notifications, initiative changes and new captures. Drive your own automations (notify a channel, update a dashboard, kick off a deploy). Pick the events each endpoint receives; each signs payloads with its own secret.
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
            The <span className="mono">X-Crumb-Event</span> header and the body&apos;s <span className="mono">type</span> name the event. Every event has an <span className="mono">id</span>, also sent as <span className="mono">X-Crumb-Event-Id</span>. It stays the same when we retry, so use it to skip duplicates.
          </p>
          <div className="code">
{`POST /your/endpoint
Content-Type: application/json
X-Crumb-Event: item.status_changed
X-Crumb-Event-Id: 3f2b8c1e-5a7d-4e19-b0c6-8d4f2a6e9b17
X-Crumb-Signature: sha256=…

${sampleBody("item.status_changed", workspace.slug)}`}
          </div>
          <div className="code">
{`// Node verification
import { createHmac, timingSafeEqual } from "node:crypto";
const expected = "sha256=" + createHmac("sha256", SECRET).update(rawBody).digest("hex");
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-crumb-signature"]));`}
          </div>
          <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
            Answer with any 2xx within 10 seconds. Timeouts, connection errors, 429 and 5xx answers are retried twice, about 2 and 10 seconds apart. Redirects are not followed. After {MAX_FAILURES} failed events in a row an endpoint pauses itself; turn it back on here once it&apos;s healthy. Send test posts the sample for the endpoint&apos;s first event with an <span className="mono">X-Crumb-Test: 1</span> header.
          </p>
        </div>
      </Card>

      <Card>
        <CardHead title="Events" after={<Pill ring>{EVENT_TYPES.length}</Pill>} />
        <div className="card-body col gap-3">
          <p className="text-sm muted note">
            Every event carries <span className="mono">id</span>, <span className="mono">type</span>, <span className="mono">workspace</span> and <span className="mono">at</span> (ISO 8601), plus the fields in its sample. Open an event to see one. Internal notes are never delivered.
          </p>
          {EVENT_TYPES.map(t => (
            <details key={t} style={{ borderTop: "var(--border)", paddingTop: 10 }}>
              <summary className="text-xs" style={{ color: "var(--ink)" }}>
                <span className="mono">{t}</span>
                <span className="muted"> · {EVENT_DOCS[t].when}</span>
              </summary>
              <div className="code" style={{ marginTop: 10 }}>{sampleBody(t, workspace.slug)}</div>
            </details>
          ))}
        </div>
      </Card>
    </>
  );
}
