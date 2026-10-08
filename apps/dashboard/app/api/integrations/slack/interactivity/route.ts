import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, accounts } from "@crumb/db";
import { verifySlackSignature } from "@/lib/slack/verify";
import { workspaceForSlackTeam } from "@/lib/slack/install";
import { slackTeammate } from "@/lib/slack/notify";
import { open } from "@/lib/crypto-at-rest";
import { integrationsAllowed } from "@/lib/entitlements";
import { composeItem } from "@/lib/compose";
import { SLACK_SOURCE } from "@/lib/feedback/source";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StateEl = { value?: string; selected_option?: { value?: string } };
type ViewSubmission = {
  type?: string;
  team?: { id?: string };
  user?: { id?: string; username?: string; team_id?: string };
  view?: { state?: { values?: Record<string, Record<string, StateEl>> } };
};

// POST /api/integrations/slack/interactivity — receives the `/crumb` modal
// submission, creates the item via composeItem (the vendor already chose the
// account). Slack sends a urlencoded `payload=<json>`; we verify the signature
// over the RAW body first.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySlackSignature(raw, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature"))) {
    return new NextResponse("invalid signature", { status: 401 });
  }

  const payloadRaw = new URLSearchParams(raw).get("payload");
  if (!payloadRaw) return new NextResponse("", { status: 200 });
  let payload: ViewSubmission;
  try {
    payload = JSON.parse(payloadRaw) as ViewSubmission;
  } catch {
    return new NextResponse("", { status: 200 });
  }
  if (payload.type !== "view_submission") return new NextResponse("", { status: 200 });

  const values = payload.view?.state?.values ?? {};
  const get = (block: string): string => {
    const el = values[block]?.["v"];
    return (el?.selected_option?.value ?? el?.value ?? "").trim();
  };
  const accountRaw = get("account");
  const type = get("type") || "question";
  const title = get("title");
  const bodyText = get("body");
  const emailIn = get("email").toLowerCase();

  const teamId = payload.team?.id;
  if (!teamId) return new NextResponse("", { status: 200 });
  const ws = await workspaceForSlackTeam(teamId);
  if (!ws || !ws.slackBotToken) return new NextResponse("", { status: 200 });
  // A form opened before a downgrade can't create items after it.
  if (!integrationsAllowed(ws)) {
    return NextResponse.json({
      response_action: "errors",
      errors: { title: "Capturing from Slack is paused on this workspace's current Crumb plan. A Crumb admin can upgrade in Settings, then Billing." },
    });
  }

  // Only this workspace's teammates create items here (as /crumb only opens the
  // form for them), matched by Slack email even if Crumb never DMed them: the
  // item is their Trail entry, and they get no new-submission alert for it.
  const teammate = await slackTeammate({
    workspaceId: ws.id,
    installTeamId: teamId,
    botToken: open(ws.slackBotToken),
    slackUserId: payload.user?.id,
    userTeamId: payload.user?.team_id ?? teamId,
  });
  if (!teammate) {
    return NextResponse.json({ response_action: "errors", errors: { title: "Only teammates in this Crumb workspace can log feedback from Slack." } });
  }

  if (!title || !accountRaw) {
    return NextResponse.json({ response_action: "errors", errors: { title: "Required", account: "Required" } });
  }

  // The select carries an account id; resolve to a name. A typed value (no
  // accounts yet) is treated as a new account name.
  let accountName = accountRaw;
  if (UUID_RE.test(accountRaw)) {
    const [acct] = await db
      .select({ name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.workspaceId, ws.id), eq(accounts.id, accountRaw)))
      .limit(1);
    if (acct) accountName = acct.name;
  }

  const submitterEmail = emailIn || `slack-${payload.user?.id ?? "unknown"}@slack.invalid`;
  const r = await composeItem({
    workspaceId: ws.id,
    accountName,
    submitterEmail,
    submitterName: payload.user?.username,
    type,
    title,
    body: bodyText,
    // The customer never opted into Crumb's loop here: don't auto-email them.
    source: SLACK_SOURCE,
    actorWorkspaceUserId: teammate.id,
  });
  if (!r.ok) {
    log.warn("slack compose failed", { scope: "crumb/slack", error: r.error });
    return NextResponse.json({ response_action: "errors", errors: { title: r.error } });
  }
  return NextResponse.json({ response_action: "clear" });
}
