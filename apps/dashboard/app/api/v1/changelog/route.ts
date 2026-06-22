import { NextResponse } from "next/server";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { listPublicChangelog } from "@/lib/changelog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public changelog ("What's new") for the embed widget. Mirrors the roadmap
// endpoint's identity + rate-limit handling. Returns only published, public
// entries, newest first.

export function OPTIONS() {
  return preflight();
}

export async function GET(req: Request) {
  const rl = await checkRateLimitAsync(`changelog:${callerIpFromRequest(req)}`, { capacity: 120, refillPerSec: 2 });
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const url = new URL(req.url);
  const r = await resolveCustomer(req, {
    workspaceSlug: url.searchParams.get("workspace"),
    email: url.searchParams.get("email"),
  });
  if (!r.ok) return fail(r.status, r.error);

  const entries = await listPublicChangelog(r.ctx.workspace.id);
  return cors(
    NextResponse.json({
      entries: entries.map((e) => ({
        id: e.id,
        title: e.title,
        body: e.body,
        published_at: e.publishedAt?.toISOString() ?? null,
      })),
    }),
  );
}
