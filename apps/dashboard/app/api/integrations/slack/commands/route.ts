import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, accounts } from "@crumb/db";
import { verifySlackSignature } from "@/lib/slack/verify";
import { buildCaptureModal, openView } from "@/lib/slack/commands";
import { workspaceForSlackTeam } from "@/lib/slack/install";
import { slackTeammate } from "@/lib/slack/notify";
import { integrationsAllowed } from "@/lib/entitlements";
import { open } from "@/lib/crypto-at-rest";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/integrations/slack/commands — the `/crumb` slash command. Verifies
// the Slack signature over the RAW body, maps team_id → workspace and user_id →
// teammate, then opens a modal (views.open) for the vendor to capture feedback
// on behalf of a customer.
// Must ack within 3s — we open the view then return an empty 200.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySlackSignature(raw, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature"))) {
    return new NextResponse("invalid signature", { status: 401 });
  }

  const params = new URLSearchParams(raw);
  const teamId = params.get("team_id");
  const triggerId = params.get("trigger_id");
  if (!teamId || !triggerId) {
    return NextResponse.json({ response_type: "ephemeral", text: "Missing Slack fields." });
  }

  const ws = await workspaceForSlackTeam(teamId);
  if (!ws || !ws.slackBotToken) {
    return NextResponse.json({ response_type: "ephemeral", text: "This Slack workspace isn't connected to Crumb yet." });
  }
  // A downgrade keeps the install but pauses using it.
  if (!integrationsAllowed(ws)) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "/crumb is paused on this workspace's current Crumb plan. A Crumb admin can upgrade in Settings, then Billing, to turn it back on.",
    });
  }

  // The form lists the customer accounts, so it opens for this workspace's
  // teammates only, not every member or guest of the Slack team. Slack runs a
  // command only for users of a team the app is installed in: team_id's.
  const botToken = open(ws.slackBotToken);
  const teammate = await slackTeammate({
    workspaceId: ws.id,
    installTeamId: teamId,
    botToken,
    slackUserId: params.get("user_id") ?? undefined,
    userTeamId: teamId,
  });
  if (!teammate) {
    return NextResponse.json({ response_type: "ephemeral", text: "Only teammates in this Crumb workspace can use /crumb." });
  }

  const accountRows = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.workspaceId, ws.id))
    .limit(100);

  const r = await openView(botToken, triggerId, buildCaptureModal(accountRows));
  if (!r.ok) {
    log.error("slack views.open failed", { scope: "crumb/slack", error: r.error });
    return NextResponse.json({ response_type: "ephemeral", text: "Couldn't open the form. Try again." });
  }
  return new NextResponse("", { status: 200 });
}
