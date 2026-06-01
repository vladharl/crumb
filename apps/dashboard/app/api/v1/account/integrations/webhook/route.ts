import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, accounts } from "@crumb/db";
import { cors, preflight, resolveCustomer } from "@/lib/public-api";
import { seal } from "@/lib/crypto-at-rest";
import { assertSafeWebhookUrl } from "@/lib/notify/url-guard";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Customer self-serve: an account admin connects their own Slack/Teams channel
// webhook from inside the widget. JWT-authed (resolveCustomer); only an account
// admin can set it. Sets the CALLER's account webhook. CORS for the embed.
//   body: { provider: "slack"|"teams", url: string|null }  (null/"" clears it)

export function OPTIONS() {
  return preflight();
}

type Body = { provider?: string; url?: string | null };

export async function POST(req: Request) {
  const rl = await checkRateLimitAsync(`acctwebhook:${callerIpFromRequest(req)}`);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const r = await resolveCustomer(req, { workspaceSlug: null, email: null });
  if (!r.ok) return cors(NextResponse.json({ error: r.error }, { status: r.status }));
  const { user } = r.ctx;
  if (user.role !== "admin") {
    return cors(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }

  let b: Body;
  try {
    b = (await req.json()) as Body;
  } catch {
    return cors(NextResponse.json({ error: "bad_json" }, { status: 400 }));
  }
  const provider = b.provider === "slack" || b.provider === "teams" ? b.provider : null;
  if (!provider) return cors(NextResponse.json({ error: "bad_provider" }, { status: 400 }));

  let value: string | null = null;
  if (b.url && b.url.trim()) {
    const guard = assertSafeWebhookUrl(b.url.trim());
    if (!guard.ok) return cors(NextResponse.json({ error: "invalid_url" }, { status: 400 }));
    value = seal(guard.url);
  }

  const set = provider === "slack" ? { slackWebhookUrl: value } : { teamsWebhookUrl: value };
  await db.update(accounts).set(set).where(eq(accounts.id, user.accountId));
  return cors(NextResponse.json({ ok: true }));
}
