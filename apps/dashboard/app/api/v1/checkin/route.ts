import { eq } from "drizzle-orm";
import { db, workspaceUsers, workspaces } from "@crumb/db";
import { CHECKIN_ANSWERS, checkinPayload, isCheckinAnswer } from "@/lib/checkin";
import { verifyReplyToken } from "@/lib/reply-token";
import { sendCheckinAnswer } from "@/lib/email";
import { esc, page } from "@/lib/simple-page";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = () => page({ title: "This link doesn’t work", text: "It may be incomplete. You can still reply to the email." }, 400);

// No login: the signed token in the link is the capability (lib/checkin.ts).
async function verify(req: Request) {
  const q = new URL(req.url).searchParams;
  const id = q.get("u") ?? "";
  const token = q.get("t") ?? "";
  const answer = q.get("a") ?? "";
  if (!UUID_RE.test(id) || !token || !isCheckinAnswer(answer)) return null;
  const [m] = await db
    .select({ name: workspaceUsers.name, email: workspaceUsers.email, ws: workspaces.name, secret: workspaces.signingSecret })
    .from(workspaceUsers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceUsers.workspaceId))
    .where(eq(workspaceUsers.id, id))
    .limit(1);
  if (!m || !verifyReplyToken(checkinPayload(id), token, m.secret)) return null;
  return { ...m, answer: CHECKIN_ANSWERS[answer] };
}

// GET /api/v1/checkin?u=<workspaceUserId>&a=fit|comparing|chat&t=<token>
// A button in the check-in email. Like unsubscribe, GET never writes: link
// scanners open every link in a message and would "pick" all three answers.
// The page posts itself back with a script (scanners don't run it), and the
// button is there if scripts are off.
export async function GET(req: Request) {
  const v = await verify(req);
  if (!v) return invalid();
  return page({
    ws: esc(v.ws),
    title: esc(v.answer.button),
    text: "Sending this to the Crumb team…",
    extra: `<form method=post><button class=primary>Send</button></form><script>document.forms[0].submit()</script>`,
  });
}

// POST, same URL: tell the operator which answer was picked.
export async function POST(req: Request) {
  const v = await verify(req);
  if (!v) return invalid();
  const ops = process.env.CRUMB_OPS_EMAIL?.trim();
  log.info("check-in answer", { scope: "crumb/checkin", workspace: v.ws, answer: v.answer.ops });
  if (ops) {
    await sendCheckinAnswer({ to: ops, workspaceName: v.ws, adminName: v.name, adminEmail: v.email, answer: v.answer.ops })
      .catch((err) => log.error("check-in answer not sent", { scope: "crumb/checkin", err: String(err) }));
  }
  return page({ ws: esc(v.ws), title: esc(v.answer.title), text: esc(v.answer.text) });
}
