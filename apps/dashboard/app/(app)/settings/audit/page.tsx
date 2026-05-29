import Link from "next/link";
import { Card, CardHead, Ic, Pill } from "@crumb/ui";
import {
  db, items, replies, statusEvents, workspaceUsers, accountUsers,
} from "@crumb/db";
import { desc, eq } from "drizzle-orm";
import { activeEmailProvider } from "@/lib/email";
import { ageFrom, getActiveSession } from "@/lib/server";
import { isCloud } from "@/lib/tier";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  open: "Open", review: "In review", planned: "Planned", progress: "In progress",
  shipped: "Shipped", declined: "Won’t ship", deferred: "Set aside", duplicate: "Duplicate",
};

type FeedEntry = {
  id: string;
  kind: "status" | "reply" | "internal_note";
  at: Date;
  shortId: string;
  itemTitle: string;
  actorName: string | null;
  summary: string;
  reason?: string | null;
};

async function loadFeed(workspaceId: string): Promise<FeedEntry[]> {
  const statusRows = await db
    .select({
      id: statusEvents.id,
      at: statusEvents.at,
      fromStatus: statusEvents.fromStatus,
      toStatus: statusEvents.toStatus,
      reason: statusEvents.reason,
      shortId: items.shortId,
      itemTitle: items.title,
      actorName: workspaceUsers.name,
    })
    .from(statusEvents)
    .innerJoin(items, eq(items.id, statusEvents.itemId))
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, statusEvents.byWorkspaceUserId))
    .where(eq(items.workspaceId, workspaceId))
    .orderBy(desc(statusEvents.at))
    .limit(40);

  const replyRows = await db
    .select({
      id: replies.id,
      at: replies.createdAt,
      internal: replies.internal,
      body: replies.body,
      shortId: items.shortId,
      itemTitle: items.title,
      vendorName: workspaceUsers.name,
      customerName: accountUsers.name,
    })
    .from(replies)
    .innerJoin(items, eq(items.id, replies.itemId))
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, replies.workspaceUserId))
    .leftJoin(accountUsers, eq(accountUsers.id, replies.accountUserId))
    .where(eq(items.workspaceId, workspaceId))
    .orderBy(desc(replies.createdAt))
    .limit(40);

  const entries: FeedEntry[] = [];

  for (const r of statusRows) {
    const fromLabel = r.fromStatus ? (STATUS_LABELS[r.fromStatus] ?? r.fromStatus) : null;
    const toLabel = STATUS_LABELS[r.toStatus] ?? r.toStatus;
    entries.push({
      id: `s:${r.id}`,
      kind: "status",
      at: r.at,
      shortId: r.shortId,
      itemTitle: r.itemTitle,
      actorName: r.actorName,
      summary: fromLabel ? `${fromLabel} → ${toLabel}` : `Submitted as ${toLabel}`,
      reason: r.reason,
    });
  }
  for (const r of replyRows) {
    entries.push({
      id: `r:${r.id}`,
      kind: r.internal ? "internal_note" : "reply",
      at: r.at,
      shortId: r.shortId,
      itemTitle: r.itemTitle,
      actorName: r.vendorName ?? r.customerName,
      summary: r.body.length > 90 ? r.body.slice(0, 89) + "…" : r.body,
    });
  }

  entries.sort((a, b) => b.at.getTime() - a.at.getTime());
  return entries.slice(0, 50);
}

export default async function AuditPage() {
  const { workspace, user } = await getActiveSession();
  const isAdmin = user.role === "admin";
  const email = activeEmailProvider();
  const cloud = isCloud();

  const feed = isAdmin ? await loadFeed(workspace.id) : [];

  return (
    <>
      <Card>
        <CardHead title="Email delivery" after={
          !cloud
            ? <Pill ring ringFill>Cloud</Pill>
            : email.name === "stdout"
              ? <Pill>stdout (dev)</Pill>
              : <Pill ring ringFill>{email.name}</Pill>
        } />
        <div className="card-body col gap-3">
          {!isAdmin ? (
            <p className="text-sm muted" style={{ margin: 0 }}>
              Only workspace admins can see email configuration.
            </p>
          ) : !cloud ? (
            <>
              <p className="text-sm" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                Magic-link and notification emails are being printed to the dashboard's stdout. <strong style={{ fontWeight: 500 }}>Managed email delivery is a Crumb Cloud feature</strong> — sign up at <a href="https://usecrumb.xyz" style={{ color: "var(--ink)" }}>usecrumb.xyz</a> to get it without running a mail server yourself.
              </p>
              <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
                Or stay on self-host and read magic links from <span className="mono">docker compose logs dashboard</span>. A bring-your-own-SMTP option for self-hosters is on the roadmap.
              </p>
            </>
          ) : email.name === "stdout" ? (
            <>
              <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
                You're on Crumb Cloud, but no email provider is configured. Set <span className="mono">CRUMB_EMAIL_PROVIDER=resend</span>, <span className="mono">RESEND_API_KEY</span>, and <span className="mono">CRUMB_EMAIL_FROM</span> to enable delivery.
              </p>
            </>
          ) : (
            <>
              <div className="row gap-3 center" style={{ flexWrap: "wrap" }}>
                <Ic.check style={{ width: 14, height: 14, color: "var(--accent-deep)" }} />
                <span className="text-sm">
                  Sending via <strong style={{ fontWeight: 500 }}>{email.name}</strong> as <span className="mono">{email.from}</span>.
                </span>
              </div>
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHead title={`Audit log · last ${feed.length}`} after={<Pill>workspace-wide</Pill>} />
        <div className="card-body col gap-3" style={{ padding: 0 }}>
          {!isAdmin ? (
            <div style={{ padding: "16px 18px" }}>
              <p className="text-sm muted" style={{ margin: 0 }}>Only admins can read the audit log.</p>
            </div>
          ) : feed.length === 0 ? (
            <div style={{ padding: "16px 18px" }}>
              <p className="text-sm muted" style={{ margin: 0 }}>
                Nothing logged yet. Status changes, replies, and notes will land here as they happen.
              </p>
            </div>
          ) : (
            <div className="list">
              {feed.map(e => (
                <Link
                  key={e.id}
                  href={`/thread/${e.shortId}`}
                  className="list-row"
                  style={{
                    gridTemplateColumns: "100px 90px 1fr 56px",
                    padding: "10px 18px",
                  }}
                >
                  <span className="text-2xs mono muted">{e.shortId}</span>
                  <span>
                    {e.kind === "status"
                      ? <Pill>status</Pill>
                      : e.kind === "internal_note"
                        ? <Pill><Ic.lock style={{ width: 9, height: 9 }} />note</Pill>
                        : <Pill>reply</Pill>}
                  </span>
                  <div className="col gap-1 grow truncate">
                    <span className="text-sm truncate" style={{ display: "block" }}>
                      <span className="fw-med">{e.actorName ?? "—"}</span>
                      <span className="muted"> · </span>
                      <span>{e.summary}</span>
                    </span>
                    {e.reason && (
                      <span className="text-xs muted" style={{ display: "block", lineHeight: 1.45 }}>
                        “{e.reason}”
                      </span>
                    )}
                    <span className="text-xs muted truncate" style={{ display: "block" }}>{e.itemTitle}</span>
                  </div>
                  <span className="text-xs muted mono" style={{ textAlign: "right" }}>{ageFrom(e.at)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
