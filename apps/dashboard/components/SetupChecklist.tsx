import Link from "next/link";
import { and, eq, sql } from "drizzle-orm";
import { Btn, Card, CardHead, Ic, Pill } from "@crumb/ui";
import { db, initiatives, workspaceUsers, type Workspace } from "@crumb/db";
import { activeEmailProvider, emailConfigured } from "@/lib/email";
import { isCloud } from "@/lib/tier";
import { hasSampleData } from "@/lib/samples";
import { onPublicRoadmapSql } from "@/lib/roadmap";
import { clearSampleData } from "@/app/(app)/settings/sample-actions";

/**
 * Setup checklist: how far a workspace is from its first closed loop. Shown on
 * the Settings overview, and on the inbox until real feedback arrives. Steps
 * are in journey order, each derived (never stored) so the list stays honest,
 * and each row links to the page that does it. Trail-dot motif: filled ember =
 * done, hairline ring = todo.
 */

export type SetupFacts = {
  widgetInstalled: boolean;
  productUrl: boolean;
  teammates: number;
  cloud: boolean;
  // A real provider (resend/smtp); null means the stdout fallback.
  emailProvider: { name: string; from: string } | null;
  toolConnected: boolean;
  roadmapPublished: boolean;
};

export type SetupStep = { title: string; detail: string; href: string; done: boolean };

export function setupSteps(f: SetupFacts): SetupStep[] {
  return [
    {
      title: "Install the widget",
      href: "/settings/install",
      done: f.widgetInstalled,
      detail: f.widgetInstalled
        ? "Your widget is live, so customers can open loops without leaving your product."
        : "Drop the snippet into your product so customers can open loops.",
    },
    {
      title: "Set your Product URL",
      href: "/settings/branding",
      done: f.productUrl,
      detail: f.productUrl
        ? "Customer emails link straight back to their thread in your product."
        : "Customer emails need it to link back to their thread in your product.",
    },
    {
      title: "Invite your team",
      href: "/settings/team",
      done: f.teammates > 1,
      detail: f.teammates > 1
        ? `${f.teammates} teammates can answer loops.`
        : "Loops close faster when more than one person can answer.",
    },
    {
      title: "Wire email delivery",
      // The Email delivery card on the Settings overview, not the install page.
      href: "/settings#email-delivery",
      done: f.cloud || f.emailProvider !== null,
      detail: f.cloud
        ? "Crumb Cloud sends customer emails for you."
        : f.emailProvider
          ? `Customers hear back via ${f.emailProvider.name} (from ${f.emailProvider.from}).`
          : "Without a provider, customers never hear back by email, so loops stay open on their side.",
    },
    {
      title: "Connect a tool",
      href: "/settings/integrations",
      done: f.toolConnected,
      detail: f.toolConnected
        ? "Connected. Tickets and notifications reach where work happens."
        : "Push loops to Linear, Jira, or GitHub; notify Slack or Teams.",
    },
    {
      title: "Publish your roadmap",
      href: "/initiatives",
      done: f.roadmapPublished,
      detail: f.roadmapPublished
        ? "Customers can watch their feedback move toward shipped."
        : "Put a public initiative in Now, Next or Later so customers see where their loops are headed.",
    },
  ];
}

// "Clear sample data". clearSampleData owns the admin check and, on success,
// revalidates every page. ponytail: the confirm is a native <details> step and a
// plain form post, so the checklist stays one server component; there's no
// pending state or toast, and a failed clear (logged server-side) just leaves
// the samples. Move to a client button with confirm() + toast if that's missed.
async function clearSamples() {
  "use server";
  await clearSampleData();
}

export async function SetupChecklist({ workspace, isAdmin, hasSamples }: {
  workspace: Workspace;
  isAdmin: boolean;
  // Callers that already know (the inbox) pass it to skip a query.
  hasSamples?: boolean;
}) {
  const ws = workspace.id;
  const [[team], [roadmap], samples] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(workspaceUsers).where(eq(workspaceUsers.workspaceId, ws)),
    // Only a public initiative customers can see (scheduled or shipped) counts.
    db.select({ n: sql<number>`count(*)::int` }).from(initiatives).where(and(
      eq(initiatives.workspaceId, ws),
      onPublicRoadmapSql(),
    )),
    hasSamples ?? hasSampleData(ws),
  ]);

  const steps = setupSteps({
    // Stamped by the widget's first real GET /api/v1/me.
    widgetInstalled: workspace.widgetFirstPingAt != null,
    productUrl: Boolean(workspace.productUrl),
    teammates: team?.n ?? 0,
    cloud: isCloud(),
    emailProvider: emailConfigured() ? activeEmailProvider() : null,
    toolConnected: Boolean(
      workspace.linearInstalledAt || workspace.jiraInstalledAt || workspace.githubInstalledAt ||
      workspace.slackInstalledAt || workspace.hubspotInstalledAt || workspace.salesforceInstalledAt ||
      workspace.teamsWebhookUrl,
    ),
    roadmapPublished: (roadmap?.n ?? 0) > 0,
  });
  const doneCount = steps.filter(s => s.done).length;

  return (
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
        {samples && (
          <div className="col gap-3" style={{ padding: "14px 18px", borderTop: "var(--border)" }}>
            <p className="text-xs muted note">
              There’s sample feedback in your inbox so you can look around.{" "}
              {isAdmin ? "Clear it once your own starts landing." : "An admin can clear it once your own starts landing."}
            </p>
            {isAdmin && (
              <details>
                <summary className="btn sm">Clear sample data</summary>
                <form action={clearSamples} className="row gap-3 center" style={{ marginTop: 10, flexWrap: "wrap" }}>
                  <span className="text-xs">This removes the sample account and all its feedback for everyone. It can’t be undone.</span>
                  <Btn sm variant="danger" type="submit">Yes, clear it</Btn>
                </form>
              </details>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
