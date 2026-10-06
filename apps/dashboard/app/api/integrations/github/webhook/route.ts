import { NextResponse } from "next/server";
import { and, eq, inArray, or } from "drizzle-orm";
import { db, items, workspaces } from "@crumb/db";
import { issueTicketRef, verifyWebhook } from "@/lib/integrations/github";
import { clearProviderInstall } from "@/lib/integrations/revoke";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GitHub webhook. Status sync only — issue close/reopen/label changes
// hit `issues.edited` / `issues.closed` / `issues.reopened`. We map to
// the externalStatus field on the linked item.
//
// Header: `X-Hub-Signature-256: sha256=<hex>`. The `X-GitHub-Event` header
// names the event type. We filter to `issues` events.

type IssuesEvent = {
  action: string; // "opened" | "closed" | "reopened" | "edited" | ...
  issue: {
    number: number;
    html_url: string;
    state: string;
    labels?: Array<{ name: string }>;
  };
  repository: { full_name: string };
  installation?: { id: number }; // on every delivery to a GitHub App webhook
};

export async function POST(req: Request) {
  const rl = await checkRateLimitAsync(`github-webhook:${callerIpFromRequest(req)}`);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  if (!verifyWebhook(raw, sig)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  const eventName = req.headers.get("x-github-event");

  // Revocation signal: the App was uninstalled or suspended. GitHub posts an
  // `installation` event; we clear the matching workspace's install so it
  // shows disconnected (and stops minting tokens against a dead installation).
  if (eventName === "installation") {
    let ev: { action?: string; installation?: { id?: number } };
    try { ev = JSON.parse(raw); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
    if ((ev.action === "deleted" || ev.action === "suspend") && ev.installation?.id != null) {
      const installId = String(ev.installation.id);
      const [ws] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.githubAppInstallId, installId))
        .limit(1);
      if (ws) await clearProviderInstall(ws.id, "github");
    }
    return NextResponse.json({ received: true });
  }

  if (eventName !== "issues") {
    return NextResponse.json({ received: true });
  }

  let event: IssuesEvent;
  try {
    event = JSON.parse(raw) as IssuesEvent;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // The webhook secret is shared by every installation of the App, so scope
  // to the workspace(s) holding the installation that sent the event, then
  // match the repo-qualified ref ("owner/repo#N").
  const installationId = event.installation?.id;
  if (installationId == null) return NextResponse.json({ received: true });
  const ticketRef = issueTicketRef(event.repository.full_name, event.issue.number);
  const newStatus = event.issue.state; // "open" | "closed"

  try {
    await db
      .update(items)
      .set({
        externalStatus:   newStatus,
        externalSyncedAt: new Date(),
        updatedAt:        new Date(),
      })
      .where(and(
        inArray(items.workspaceId, db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.githubAppInstallId, String(installationId)))),
        eq(items.externalProvider, "github"),
        or(
          eq(items.externalTicketId, ticketRef),
          // ponytail: rows linked before refs were repo-qualified hold a bare
          // "#N"; their stored issue URL pins the repo. Drop once none remain.
          and(
            eq(items.externalTicketId, `#${event.issue.number}`),
            eq(items.externalTicketUrl, event.issue.html_url),
          ),
        ),
      ));
  } catch (err) {
    log.error("github webhook DB update failed", { scope: "crumb/github", ticketRef, err });
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
