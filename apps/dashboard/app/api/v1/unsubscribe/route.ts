import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { db, accountUsers, workspaces } from "@crumb/db";
import { esc, page } from "@/lib/simple-page";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What each link scope turns off (and Undo turns back on), named like the
// widget's Notifications toggles. The default scope mutes ALL customer email.
const SCOPES = {
  all:     { name: "all email",       about: "about your feedback and their roadmap",       off: { unsubscribedAll: true }, on: { unsubscribedAll: false } },
  replies: { name: "replies",         about: "when they reply to your feedback",            off: { notifyReplies: false },  on: { notifyReplies: true } },
  status:  { name: "status changes",  about: "when your feedback changes status",           off: { notifyStatus: false },   on: { notifyStatus: true } },
  roadmap: { name: "roadmap updates", about: "about what you follow or asked for on their roadmap", off: { notifyRoadmap: false },  on: { notifyRoadmap: true } },
} as const;

const NOTE = `<p class=note>You can change this anytime from the feedback widget.</p>`;

const invalid = () => page({
  title: "This link doesn’t work",
  text: "It may be incomplete or out of date.",
  extra: `<p class=note>You can still change your email settings from the feedback widget.</p>`,
}, 400);

// No login: the per-user token in the link is the capability. Constant-time
// compare; any mismatch (or unknown user) reads as invalid.
async function verify(req: Request) {
  const q = new URL(req.url).searchParams;
  const userId = q.get("u") ?? "";
  const token = q.get("t") ?? "";
  const scope = (q.get("scope") ?? "all").toLowerCase();
  if (!UUID_RE.test(userId) || !token || !Object.hasOwn(SCOPES, scope)) return null;

  const [user] = await db
    .select({ id: accountUsers.id, unsubToken: accountUsers.unsubToken, workspace: workspaces.name })
    .from(accountUsers)
    .innerJoin(workspaces, eq(workspaces.id, accountUsers.workspaceId))
    .where(eq(accountUsers.id, userId))
    .limit(1);
  const a = Buffer.from(token);
  const b = Buffer.from(user?.unsubToken ?? "");
  if (!user || a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { id: user.id, ws: esc(user.workspace), scope: SCOPES[scope as keyof typeof SCOPES] };
}

// GET /api/v1/unsubscribe?u=<userId>&t=<token>[&scope=replies|status|roadmap]
// The link in a customer email. It only asks: corporate link scanners open
// every link in a message, so a GET that wrote would silently unsubscribe people.
export async function GET(req: Request) {
  const v = await verify(req);
  if (!v) return invalid();
  return page({
    ws: v.ws,
    title: `Unsubscribe from ${v.scope.name}?`,
    text: `${v.ws} will stop emailing you ${v.scope.about}.`,
    extra: `<form method=post><input type=hidden name=action value=unsubscribe><button class=primary>Confirm</button></form>`,
  });
}

// POST, same URL (the form above posts back to it). Three callers:
//  - Confirm (action=unsubscribe): apply, then offer Undo;
//  - Undo (action=resubscribe, same token): turn the scope back on;
//  - RFC 8058 one-click from the inbox (body List-Unsubscribe=One-Click, what
//    the List-Unsubscribe-Post header advertises): apply, no page.
export async function POST(req: Request) {
  const v = await verify(req);
  if (!v) return invalid();
  const form = await req.formData().catch(() => null);
  const undo = form?.get("action") === "resubscribe";
  await db.update(accountUsers).set(undo ? v.scope.on : v.scope.off).where(eq(accountUsers.id, v.id));
  if (form?.get("List-Unsubscribe") === "One-Click") return new NextResponse(null, { status: 200 });

  return undo
    ? page({
        ws: v.ws,
        title: "Emails are back on",
        text: `${v.ws} will keep emailing you ${v.scope.about}.`,
        extra: NOTE,
      })
    : page({
        ws: v.ws,
        title: "You’re unsubscribed",
        text: `${v.ws} will no longer email you ${v.scope.about}.`,
        extra: `<form method=post><input type=hidden name=action value=resubscribe><button>Undo</button></form>${NOTE}`,
      });
}
