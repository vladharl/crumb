import { NextResponse } from "next/server";
import { db, workspaces, items, replies, statusEvents, initiatives, initiativeSuggestions, replaySessions } from "@crumb/db";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { callerIpFromRequest, checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { suggestInitiative, clusterConfigured, CLUSTER_MODEL } from "@/lib/ai/cluster";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public endpoint for the embedded widget.
// Auth: JWT preferred (workspace-signed HS256); trusted-email fallback for
// the bundled demo on self-host (rejected on Cloud — see lib/public-api.ts).
// Rate-limited in two layers: per-source-IP at the top (cheap pre-auth
// reject) and per-workspace after resolveCustomer succeeds (looser cap;
// guards against a single workspace burning through their bucket).

export function OPTIONS() {
  return preflight();
}

// ─── GET /api/v1/items[?workspace&email] ──────────────────────
// Returns the calling customer's submissions (newest first).
// Auth: prefer Bearer JWT; falls back to query params for the demo embed.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const r = await resolveCustomer(req, {
    workspaceSlug: url.searchParams.get("workspace"),
    email: url.searchParams.get("email"),
  });
  if (!r.ok) return fail(r.status, r.error);

  const rows = await db
    .select({
      shortId: items.shortId,
      title: items.title,
      type: items.type,
      status: items.status,
      createdAt: items.createdAt,
      updatedAt: items.updatedAt,
      replyCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${replies}
        WHERE ${replies.itemId} = ${items.id}
          AND ${replies.internal} = false
      )`,
    })
    .from(items)
    .where(and(
      eq(items.workspaceId, r.ctx.workspace.id),
      eq(items.submitterId, r.ctx.user.id),
    ))
    .orderBy(desc(items.updatedAt));

  return cors(NextResponse.json({
    items: rows.map(row => ({
      short_id: row.shortId,
      title: row.title,
      type: row.type,
      status: row.status,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      reply_count: row.replyCount,
    })),
  }));
}

type CreateBody = {
  workspace_slug?: string;
  account_user_email?: string;
  account_user_name?: string;
  account_name?: string;
  type?: "bug" | "idea" | "question";
  title?: string;
  body?: string;
  // Optional replay session linker. The widget includes this only after at
  // least one chunk has flushed — avoids creating dead empty rows when the
  // recorder is enabled but never emits anything before submit.
  session_token?: string;
};

const ALLOWED_TYPES = new Set(["bug", "idea", "question"]);

// ─── POST /api/v1/items ────────────────────────────────────────
// Creates an item. JWT-authed if the Bearer header is present; otherwise
// trusts body fields (for the demo embed).
export async function POST(req: Request) {
  // Rate-limit before parsing — keep spammy clients cheap.
  const rl = checkRateLimit(`items:${callerIpFromRequest(req)}`);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let payload: CreateBody;
  try {
    payload = await req.json();
  } catch {
    return fail(400, "invalid_json");
  }

  const { workspace_slug, account_user_email, account_user_name, account_name, type, title, body, session_token } = payload;
  if (!type || !ALLOWED_TYPES.has(type)) return fail(400, "invalid_type");
  if (!title || !title.trim()) return fail(400, "missing_title");

  const r = await resolveCustomer(req, {
    workspaceSlug: workspace_slug ?? null,
    email: account_user_email ?? null,
    accountName: account_name ?? null,
    userName: account_user_name ?? null,
  });
  if (!r.ok) return fail(r.status, r.error);
  const ws = r.ctx.workspace;
  const user = r.ctx.user;

  // Per-workspace bucket — looser cap than the per-IP one; both must pass.
  const wsRl = checkRateLimit(`items:ws:${ws.id}`, { capacity: 600, refillPerSec: 10 });
  if (!wsRl.ok) return tooManyRequests(wsRl.retryAfterSeconds);

  const [bumped] = await db
    .update(workspaces)
    .set({ nextItemSeq: sql`${workspaces.nextItemSeq} + 1` })
    .where(eq(workspaces.id, ws.id))
    .returning({ next: workspaces.nextItemSeq });
  const seq = (bumped?.next ?? 1) - 1;
  const shortId = `FB-${seq}`;

  const [created] = await db.insert(items).values({
    workspaceId: ws.id,
    accountId: user.accountId,
    submitterId: user.id,
    seq,
    shortId,
    title: title.trim(),
    body: (body ?? "").trim(),
    type,
    status: "open",
  }).returning();

  // Initial status event so the timeline always starts with "Submitted".
  await db.insert(statusEvents).values({
    itemId: created!.id,
    fromStatus: null,
    toStatus: "open",
  });

  // Seed the first message in the thread so the customer's own words appear in the reply feed.
  if (body && body.trim()) {
    await db.insert(replies).values({
      itemId: created!.id,
      accountUserId: user.id,
      body: body.trim(),
      internal: false,
    });
  }

  // Link a replay session if the widget passed a token. Best-effort: the
  // session must belong to this workspace and have ≥1 chunk (empty rows
  // exist before any chunk flushes, but we only attach ones with actual
  // content). Failures here don't block item creation.
  if (session_token && /^[0-9a-f]{32}$/.test(session_token)) {
    try {
      const [replay] = await db
        .select({ id: replaySessions.id, workspaceId: replaySessions.workspaceId, eventCount: replaySessions.eventCount })
        .from(replaySessions)
        .where(eq(replaySessions.sessionToken, session_token))
        .limit(1);
      if (replay && replay.workspaceId === ws.id && replay.eventCount > 0) {
        // Also stamp account_user_id while we have it — lets the per-
        // account session list join cleanly without going through items
        // every time, and unlocks a future per-customer session view.
        await db
          .update(replaySessions)
          .set({ itemId: created!.id, accountUserId: user.id })
          .where(eq(replaySessions.id, replay.id));
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[crumb/replay] linking session_token failed:", err);
    }
  }

  // Fire-and-forget AI clustering. Customer doesn't wait for the LLM call
  // — the item is already saved. Errors get swallowed by the helper.
  if (clusterConfigured()) {
    void autoCluster(ws.id, created!.id, created!.title, created!.body, created!.type);
  }

  return cors(NextResponse.json({
    id: created!.id,
    short_id: created!.shortId,
    status: created!.status,
    created_at: created!.createdAt,
  }, { status: 201 }));
}

async function autoCluster(
  workspaceId: string,
  itemId: string,
  title: string,
  body: string,
  type: string,
): Promise<void> {
  try {
    const candidates = await db
      .select({ id: initiatives.id, name: initiatives.name, description: initiatives.description })
      .from(initiatives)
      .where(and(eq(initiatives.workspaceId, workspaceId), ne(initiatives.status, "parked")));
    if (candidates.length === 0) return;

    const guess = await suggestInitiative(
      { title, body, type },
      candidates,
    );
    if (!guess) return;

    await db.insert(initiativeSuggestions).values({
      itemId,
      initiativeId: guess.initiativeId,
      confidence: guess.confidence,
      reason: guess.reason,
      model: CLUSTER_MODEL,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[crumb/ai] autoCluster failed:", err);
  }
}
