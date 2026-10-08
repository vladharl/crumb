import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, accounts } from "@crumb/db";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { open, seal } from "@/lib/crypto-at-rest";
import { assertSafeWebhookUrl } from "@/lib/notify/url-guard";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Customer self-serve: an account admin connects their own Slack/Teams channel
// webhook from inside the widget. JWT-authed (resolveCustomer); only an account
// admin can see or change it, and only on the CALLER's account. CORS for the embed.
//   GET                           → { slack: { connected, masked_url }, teams: { … } }
//   POST   { provider, url }      → set it (null/"" clears it)
//   DELETE ?provider=slack|teams  → clear it

export function OPTIONS() {
  return preflight();
}

type Provider = "slack" | "teams";
const asProvider = (v: unknown): Provider | null => (v === "slack" || v === "teams" ? v : null);
const setColumn = (p: Provider, value: string | null) =>
  p === "slack" ? { slackWebhookUrl: value } : { teamsWebhookUrl: value };

// One gate for every verb, as the original POST had it: rate limit, a
// JWT-resolved customer (no trusted-email fallback), account admin.
async function accountAdmin(req: Request): Promise<{ res: Response } | { accountId: string }> {
  const rl = await checkRateLimitAsync(`acctwebhook:${callerIpFromRequest(req)}`);
  if (!rl.ok) return { res: tooManyRequests(rl.retryAfterSeconds) };
  const r = await resolveCustomer(req, { workspaceSlug: null, email: null });
  if (!r.ok) return { res: fail(r.status, r.error) };
  if (r.ctx.user.role !== "admin") return { res: fail(403, "forbidden") };
  return { accountId: r.ctx.user.accountId };
}

// Enough to recognize the channel, never enough to post to it: host plus the
// last 4 characters. Null when it can't be opened (key no longer configured).
function masked(sealed: string | null | undefined): { connected: boolean; masked_url: string | null } {
  if (!sealed) return { connected: false, masked_url: null };
  try {
    const url = open(sealed);
    return { connected: true, masked_url: `${new URL(url).host}/…${url.slice(-4)}` };
  } catch {
    return { connected: true, masked_url: null };
  }
}

export async function GET(req: Request) {
  const gate = await accountAdmin(req);
  if ("res" in gate) return gate.res;
  const [a] = await db
    .select({ slack: accounts.slackWebhookUrl, teams: accounts.teamsWebhookUrl })
    .from(accounts)
    .where(eq(accounts.id, gate.accountId))
    .limit(1);
  return cors(NextResponse.json({ slack: masked(a?.slack), teams: masked(a?.teams) }));
}

export async function POST(req: Request) {
  const gate = await accountAdmin(req);
  if ("res" in gate) return gate.res;

  let b: { provider?: unknown; url?: unknown } | null;
  try {
    b = await req.json();
  } catch {
    return fail(400, "bad_json");
  }
  const provider = asProvider(b?.provider);
  if (!provider) return fail(400, "bad_provider");

  const url = b?.url ?? ""; // null / "" clears it
  if (typeof url !== "string") return fail(400, "invalid_url");
  let value: string | null = null;
  const raw = url.trim();
  if (raw) {
    const guard = assertSafeWebhookUrl(raw);
    if (!guard.ok) return fail(400, "invalid_url");
    value = seal(guard.url);
  }

  await db.update(accounts).set(setColumn(provider, value)).where(eq(accounts.id, gate.accountId));
  return cors(NextResponse.json({ ok: true }));
}

export async function DELETE(req: Request) {
  const gate = await accountAdmin(req);
  if ("res" in gate) return gate.res;
  const provider = asProvider(new URL(req.url).searchParams.get("provider"));
  if (!provider) return fail(400, "bad_provider");
  await db.update(accounts).set(setColumn(provider, null)).where(eq(accounts.id, gate.accountId));
  return cors(NextResponse.json({ ok: true }));
}
