import { NextResponse } from "next/server";
import { and, eq, inArray, or } from "drizzle-orm";
import { db, items, workspaces } from "@crumb/db";
import { issueTicketRef, verifyWebhook } from "@/lib/integrations/github";
import { clearProviderInstall } from "@/lib/integrations/revoke";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { log } from "@/lib/log";
import { byTicket, syncExternalStatus } from "@/lib/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GitHub webhook. Status sync only — issue close/reopen/label changes
// hit `issues.edited` / `issues.closed` / `issues.reopened`. We map to
// the externalStatus field on the linked item (and emit
// item.external_status_changed).
//
// Header: `X-Hub-Signature-256: sha256=<hex>`. The `X-GitHub-Event` header
// names the event type. We filter to `issues` events.
//
// An item matches on the issue's node id, which a repository rename or
// transfer keeps, and takes the issue's current owner/repo#N and URL; an
// issue transferred to another repository (`transferred`) moves the link to
// the new issue. Items linked before node ids were stored match on their ref
// once and get the id then.

type Issue = {
  number: number;
  node_id?: string;
  html_url: string;
  state: string;
  // Why it closed: "completed", "not_planned" or "duplicate" (null on older issues).
  state_reason?: string | null;
  labels?: Array<{ name: string }>;
};

type IssuesEvent = {
  action: string; // "opened" | "closed" | "reopened" | "edited" | "transferred" | ...
  issue: Issue;
  repository: { full_name: string };
  // On `transferred`: the issue as it now is, in its new repository.
  changes?: { new_issue?: Issue; new_repository?: { full_name: string } };
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
  const { new_issue: movedTo, new_repository: movedRepo } = event.changes ?? {};
  const now = event.action === "transferred" && movedTo && movedRepo
    ? { issue: movedTo, ref: issueTicketRef(movedRepo.full_name, movedTo.number) }
    : { issue: event.issue, ref: ticketRef };
  // "open" | "closed", or "closed (not planned)" / "closed (duplicate)": an
  // issue closed without doing the work must not read as engineering done.
  const reason = now.issue.state_reason;
  const newStatus = now.issue.state === "closed" && reason && reason !== "completed"
    ? `closed (${reason.replace(/_/g, " ")})`
    : now.issue.state;

  try {
    await syncExternalStatus(and(
      inArray(items.workspaceId, db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.githubAppInstallId, String(installationId)))),
      eq(items.externalProvider, "github"),
      byTicket(event.issue.node_id, or(
        eq(items.externalTicketId, ticketRef),
        // ponytail: rows linked before refs were repo-qualified hold a bare
        // "#N"; their stored issue URL pins the repo. Drop once none remain.
        and(
          eq(items.externalTicketId, `#${event.issue.number}`),
          eq(items.externalTicketUrl, event.issue.html_url),
        ),
      )!),
    ), newStatus, { uid: now.issue.node_id, key: now.ref, url: now.issue.html_url });
  } catch (err) {
    log.error("github webhook DB update failed", { scope: "crumb/github", ticketRef, err });
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
