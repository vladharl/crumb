import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, accounts } from "@crumb/db";
import { verifySlackSignature } from "@/lib/slack/verify";
import { workspaceForSlackTeam } from "@/lib/slack/install";
import { composeItem } from "@/lib/compose";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StateEl = { value?: string; selected_option?: { value?: string } };
type ViewSubmission = {
  type?: string;
  team?: { id?: string };
  user?: { id?: string; username?: string };
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
  if (!ws) return new NextResponse("", { status: 200 });

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
  });
  if (!r.ok) {
    log.warn("slack compose failed", { scope: "crumb/slack", error: r.error });
    return NextResponse.json({ response_action: "errors", errors: { title: r.error } });
  }
  return NextResponse.json({ response_action: "clear" });
}
