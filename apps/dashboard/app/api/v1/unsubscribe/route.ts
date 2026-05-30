import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { db, accountUsers } from "@crumb/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(title: string, msg: string, status = 200) {
  const body = `<!doctype html><html lang=en><head><meta charset=utf-8>` +
    `<meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;` +
    `background:#f7f6f3;color:#1c1a17;display:grid;place-items:center;min-height:100vh;margin:0}` +
    `.card{background:#fff;border:1px solid #e7e3dc;border-radius:14px;padding:28px 32px;` +
    `max-width:420px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.06)}` +
    `h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#6b6457}</style></head>` +
    `<body><div class=card><h1>${title}</h1><p>${msg}</p></div></body></html>`;
  return new NextResponse(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// GET /api/v1/unsubscribe?u=<userId>&t=<token>[&scope=replies|status|roadmap]
// One-click unsubscribe from a customer email. No login — the per-user token in
// the link is the capability. Default scope mutes ALL email; a scope turns off
// just that type. Re-enable anytime from the widget's Notifications view.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const userId = url.searchParams.get("u") ?? "";
  const token = url.searchParams.get("t") ?? "";
  const scope = (url.searchParams.get("scope") ?? "all").toLowerCase();
  if (!UUID_RE.test(userId) || !token) {
    return page("Invalid link", "This unsubscribe link is missing or malformed.", 400);
  }

  const [user] = await db
    .select({ id: accountUsers.id, unsubToken: accountUsers.unsubToken })
    .from(accountUsers)
    .where(eq(accountUsers.id, userId))
    .limit(1);

  // Constant-time compare; any mismatch (or unknown user) reads as invalid.
  const a = Buffer.from(token);
  const b = Buffer.from(user?.unsubToken ?? "");
  const ok = !!user && a.length === b.length && timingSafeEqual(a, b);
  if (!ok) return page("Invalid link", "This unsubscribe link is invalid or has expired.", 400);

  if (scope === "all") {
    await db.update(accountUsers).set({ unsubscribedAll: true }).where(eq(accountUsers.id, user.id));
  } else if (scope === "replies") {
    await db.update(accountUsers).set({ notifyReplies: false }).where(eq(accountUsers.id, user.id));
  } else if (scope === "status") {
    await db.update(accountUsers).set({ notifyStatus: false }).where(eq(accountUsers.id, user.id));
  } else if (scope === "roadmap") {
    await db.update(accountUsers).set({ notifyRoadmap: false }).where(eq(accountUsers.id, user.id));
  } else {
    return page("Invalid link", "Unknown notification type.", 400);
  }

  return page(
    "Unsubscribed",
    "You won’t receive these emails anymore. You can re-enable notifications anytime from the feedback widget.",
  );
}
