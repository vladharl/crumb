import { NextResponse } from "next/server";
import { db, accounts, items } from "@crumb/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { createItem, SubmitterBlockedError } from "@/lib/items/create";
import { linkReplaySession } from "@/lib/replay/ingest";
import { WIDGET_SOURCE } from "@/lib/feedback/source";
import { createItemSchema, parseJsonBody } from "@/lib/validation";
import { loopTurn } from "@/lib/loop";
import { lastTurnSideSql } from "@/lib/loop-sql";
import { customerStatusSql, mergedSql } from "@/lib/customer-status";
import { log } from "@/lib/log";

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
      body: items.body,
      type: items.type,
      // A request merged into another reads like that one (lib/customer-status).
      status: customerStatusSql(),
      merged: mergedSql(),
      createdAt: items.createdAt,
      updatedAt: items.updatedAt,
      // Fully-qualified raw refs, NOT ${items.id}/${replies.*}: inside a raw
      // subquery template drizzle renders interpolated columns unqualified, so
      // ${items.id} -> "id" resolves to replies.id (the inner table's own id)
      // instead of the outer item — silently making every count 0.
      replyCount: sql<number>`(
        SELECT COUNT(*)::int FROM replies
        WHERE replies.item_id = items.id
          AND replies.internal = false
      )`,
      // Loop-turn inputs for the launcher: whose turn it is (the same rule
      // the inbox uses, so the two agree), and the latest customer-visible
      // event (reply vs status change) so the whisper tab can phrase
      // "Maya replied" / "Shipped: …" without another request.
      lastReplySide: lastTurnSideSql(items.id),
      lastReplyAtMs: sql<number | null>`(
        SELECT (EXTRACT(EPOCH FROM MAX(r.created_at)) * 1000)::double precision
        FROM replies r
        WHERE r.item_id = items.id AND r.internal = false
      )`,
      lastReplyAuthor: sql<string | null>`(
        SELECT COALESCE(wu.name, au.name)
        FROM replies r
        LEFT JOIN workspace_users wu ON wu.id = r.workspace_user_id
        LEFT JOIN account_users au ON au.id = r.account_user_id
        WHERE r.item_id = items.id AND r.internal = false
        ORDER BY r.created_at DESC
        LIMIT 1
      )`,
      lastStatusAtMs: sql<number | null>`(
        SELECT (EXTRACT(EPOCH FROM MAX(se.at)) * 1000)::double precision
        FROM status_events se
        WHERE se.item_id = items.id AND se.from_status IS NOT NULL
      )`,
      // Vendor-only signal for the launcher's unread badge. reply_count and
      // last_event include the customer's own messages (the item body is
      // stored as the first reply), so they can't say "someone answered you".
      // Vendor = the thread payload's kind "vendor": a workspace user wrote it.
      vendorReplyCount: sql<number>`(
        SELECT COUNT(*)::int FROM replies r
        WHERE r.item_id = items.id AND r.internal = false AND r.workspace_user_id IS NOT NULL
      )`,
      lastVendorReplyAtMs: sql<number | null>`(
        SELECT (EXTRACT(EPOCH FROM MAX(r.created_at)) * 1000)::double precision
        FROM replies r
        WHERE r.item_id = items.id AND r.internal = false AND r.workspace_user_id IS NOT NULL
      )`,
    })
    .from(items)
    .where(and(
      eq(items.workspaceId, r.ctx.workspace.id),
      eq(items.submitterId, r.ctx.user.id),
    ))
    .orderBy(desc(items.updatedAt));

  return cors(NextResponse.json({
    items: rows.map(row => {
      const replyEvent = row.lastReplyAtMs !== null
        ? { kind: "reply" as const, at: new Date(row.lastReplyAtMs).toISOString(), author_name: row.lastReplyAuthor }
        : null;
      const statusEvent = row.lastStatusAtMs !== null
        ? { kind: "status" as const, at: new Date(row.lastStatusAtMs).toISOString(), status: row.status }
        : null;
      const lastEvent =
        replyEvent && statusEvent
          ? (row.lastReplyAtMs! >= row.lastStatusAtMs! ? replyEvent : statusEvent)
          : replyEvent ?? statusEvent;
      return {
        short_id: row.shortId,
        title: row.title,
        body: row.body,
        type: row.type,
        status: row.status,
        merged: row.merged,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        reply_count: row.replyCount,
        last_reply_side: row.lastReplySide,
        turn: loopTurn({ status: row.status, lastReplySide: row.lastReplySide }),
        last_event: lastEvent,
        vendor_reply_count: row.vendorReplyCount,
        // Same ms rounding as last_event.at, so the two are equal exactly when
        // the latest event is a vendor reply.
        last_vendor_reply_at: row.lastVendorReplyAtMs !== null ? new Date(row.lastVendorReplyAtMs).toISOString() : null,
      };
    }),
  }));
}

// ─── POST /api/v1/items ────────────────────────────────────────
// Creates an item. JWT-authed if the Bearer header is present; otherwise
// trusts body fields (for the demo embed). The optional `session_token`
// links the customer's replay recording to the new item.
export async function POST(req: Request) {
  // Rate-limit before parsing — keep spammy clients cheap.
  const rl = await checkRateLimitAsync(`items:${callerIpFromRequest(req)}`);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const parsed = await parseJsonBody(req, createItemSchema);
  if (!parsed.ok) return fail(parsed.status, parsed.error);
  const { workspace_slug, account_user_email, account_user_name, account_name, type, title, body, session_token, context, attachment_ids } = parsed.data;

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
  const wsRl = await checkRateLimitAsync(`items:ws:${ws.id}`, { capacity: 600, refillPerSec: 10 });
  if (!wsRl.ok) return tooManyRequests(wsRl.retryAfterSeconds);

  // The account the customer actually belongs to (a JWT body carries no
  // account_name), for the item.created payload and the Teams post.
  const [acct] = await db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, user.accountId)).limit(1);

  // The shared core: sequence, item, "Submitted" event, the seed message with
  // the compose files, then item.created, the Teams post, the new-submission
  // alert, and AI clustering + triage + embedding when entitled.
  const created = await createItem({
    workspaceId: ws.id,
    accountId: user.accountId,
    accountName: acct?.name ?? "a customer",
    submitterId: user.id,
    submitterName: user.name,
    type,
    title,
    body,
    // Widget-origin: the customer raised this through the embed widget, so they
    // opted into Crumb's loop and may be auto-notified (see lib/feedback/source).
    source: WIDGET_SOURCE,
    // Page / browser / app build; capped and redacted by createItemSchema.
    context: context ?? null,
    attachmentIds: attachment_ids,
  }).catch((err: unknown) => {
    if (err instanceof SubmitterBlockedError) return null;
    throw err;
  });
  // Their feedback was marked as spam: a plain refusal the widget can show,
  // without saying why.
  if (!created) {
    return cors(NextResponse.json(
      { error: "submitter_blocked", message: "We can't accept feedback from you here." },
      { status: 403 },
    ));
  }

  // Link the customer's recording if the widget passed its token, even when
  // no chunk has landed yet (see linkReplaySession). Best-effort: failures
  // here don't block item creation.
  if (session_token) {
    await linkReplaySession(ws, created, session_token).catch((err: unknown) => {
      log.error("linking replay session_token failed", { scope: "crumb/replay", err });
    });
  }

  return cors(NextResponse.json({
    id: created.id,
    short_id: created.shortId,
    status: created.status,
    created_at: created.createdAt,
  }, { status: 201 }));
}
