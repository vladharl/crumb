import Link from "next/link";
import { and, eq, sql } from "drizzle-orm";
import { Card, CardHead, Ic, Pill } from "@crumb/ui";
import { db, items, workspaceUsers, initiatives } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { activeEmailProvider, emailConfigured } from "@/lib/email";
import { EmailDeliveryCard } from "./EmailDeliveryCard";

export const dynamic = "force-dynamic";

/**
 * Settings landing: setup state at a glance instead of a redirect to Team.
 * Five steps in journey order — each row shows done/todo (the trail-dot motif:
 * filled ember = done, hairline ring = todo) and links to the page that does
 * it. Statuses are derived, never stored, so the list stays honest.
 */

type Step = {
  title: string;
  detail: string;
  href: string;
  done: boolean;
  external?: boolean;
};

export default async function SettingsOverview() {
  const { workspace, user } = await getActiveSession();
  const ws = workspace.id;

  const [[itemCount], [memberCount], [publicInitiative]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(items).where(eq(items.workspaceId, ws)),
    db.select({ n: sql<number>`count(*)::int` }).from(workspaceUsers).where(eq(workspaceUsers.workspaceId, ws)),
    db.select({ n: sql<number>`count(*)::int` }).from(initiatives)
      .where(and(eq(initiatives.workspaceId, ws), eq(initiatives.isPublic, true))),
  ]);

  const anyIntegration = Boolean(
    workspace.linearInstalledAt || workspace.jiraInstalledAt || workspace.githubInstalledAt ||
    workspace.slackInstalledAt || workspace.hubspotInstalledAt || workspace.salesforceInstalledAt ||
    workspace.teamsWebhookUrl,
  );
  const email = activeEmailProvider();

  const steps: Step[] = [
    {
      title: "Install the widget",
      detail: (itemCount?.n ?? 0) > 0
        ? "Feedback is flowing — loops are arriving in your Inbox."
        : "Drop the snippet into your product so customers can open loops.",
      href: "/settings/install",
      done: (itemCount?.n ?? 0) > 0,
    },
    {
      title: "Invite your team",
      detail: (memberCount?.n ?? 0) > 1
        ? `${memberCount!.n} teammates can answer loops.`
        : "Loops close faster when more than one person can answer.",
      href: "/settings/team",
      done: (memberCount?.n ?? 0) > 1,
    },
    {
      title: "Wire email delivery",
      detail: emailConfigured()
        ? `Customers hear back via ${email.name} (from ${email.from}).`
        : "Without a provider, customers never hear back by email — loops stay open on their side.",
      href: "/settings/install",
      done: emailConfigured(),
    },
    {
      title: "Connect a tool",
      detail: anyIntegration
        ? "Connected — tickets and notifications reach where work happens."
        : "Push loops to Linear, Jira, or GitHub; notify Slack or Teams.",
      href: "/settings/integrations",
      done: anyIntegration,
    },
    {
      title: "Publish your roadmap",
      detail: (publicInitiative?.n ?? 0) > 0
        ? "Customers can watch their feedback move toward shipped."
        : "Mark an initiative public so customers see where their loops are headed.",
      href: "/initiatives",
      done: (publicInitiative?.n ?? 0) > 0,
    },
  ];

  const doneCount = steps.filter(s => s.done).length;

  return (
    <>
    <Card>
      <CardHead
        title="Setup"
        after={<Pill ring>{doneCount} of {steps.length} done</Pill>}
      />
      <div className="col">
        {steps.map(s => (
          <Link
            key={s.title}
            href={s.href}
            className="row gap-3"
            style={{
              alignItems: "flex-start",
              padding: "14px 18px",
              borderTop: "var(--border)",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            {s.done ? (
              <span aria-hidden style={{
                width: 12, height: 12, borderRadius: 999, background: "var(--ember)",
                flexShrink: 0, marginTop: 4,
              }} />
            ) : (
              <span aria-hidden style={{
                width: 12, height: 12, borderRadius: 999, border: "1.5px solid var(--hair-strong)",
                flexShrink: 0, marginTop: 4,
              }} />
            )}
            <div className="col gap-1 grow">
              <span className="text-sm fw-med">{s.title}</span>
              <span className="text-xs muted" style={{ lineHeight: 1.5 }}>{s.detail}</span>
            </div>
            <span className="text-xs muted row gap-1 center" style={{ flexShrink: 0, marginTop: 2 }}>
              {s.done ? "Done" : "Set up"}
              <Ic.chevR style={{ width: 10, height: 10 }} />
            </span>
          </Link>
        ))}
      </div>
    </Card>
    <EmailDeliveryCard isAdmin={user.role === "admin"} />
    </>
  );
}
