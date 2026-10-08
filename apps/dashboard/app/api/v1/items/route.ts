import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db, workspaces, workspaceUsers, items, itemEmbeddings, dedupeSuggestions, replies, statusEvents, replaySessions, attachments } from "@crumb/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";
import { clusterConfigured } from "@/lib/ai/cluster";
import { autoClusterItem } from "@/lib/ai/auto-cluster";
import { suggestTriage, triageConfigured, TRIAGE_MODEL } from "@/lib/ai/triage";
import { embedText, embeddingsConfigured, EMBEDDINGS_MODEL, EMBEDDINGS_DIM } from "@/lib/ai/embeddings";
import { findDuplicateCandidates } from "@/lib/ai/dedup";
import { withAiBudget } from "@/lib/ai/run";
import { notifyWorkspaceChannel } from "@/lib/notify/chat";
import { hasFeature } from "@/lib/entitlements";
import { createItemSchema, parseJsonBody } from "@/lib/validation";
import { loopTurn } from "@/lib/loop";
import { log } from "@/lib/log";
import type { Workspace } from "@crumb/db";

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
      status: items.status,
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
      // Loop-turn inputs for the launcher: who moved last, and the latest
      // customer-visible event (reply vs status change) so the whisper tab
      // can phrase "Maya replied" / "Shipped: …" without another request.
      lastReplySide: sql<"vendor" | "customer" | null>`(
        SELECT CASE WHEN r.workspace_user_id IS NOT NULL THEN 'vendor' ELSE 'customer' END
        FROM replies r
        WHERE r.item_id = items.id AND r.internal = false
        ORDER BY r.created_at DESC
        LIMIT 1
      )`,
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
// trusts body fields (for the demo embed). The `session_token` field is an
// optional replay-session linker — the widget includes it only after ≥1
// chunk has flushed, avoiding dead empty rows.
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
    // Widget-origin: the customer raised this through the embed widget, so they
    // opted into Crumb's loop and may be auto-notified (see lib/feedback/source).
    source: "widget",
    // Page / browser / app build; capped and redacted by createItemSchema.
    context: context ?? null,
  }).returning();

  // Initial status event so the timeline always starts with "Submitted".
  await db.insert(statusEvents).values({
    itemId: created!.id,
    fromStatus: null,
    toStatus: "open",
  });

  // Seed the first message in the thread so the customer's own words appear in
  // the reply feed, with the files they attached in compose: their own uploads
  // not yet on a message, as the reply route links them.
  const attachmentIds = attachment_ids ?? [];
  if ((body && body.trim()) || attachmentIds.length) {
    const [first] = await db.insert(replies).values({
      itemId: created!.id,
      accountUserId: user.id,
      body: (body ?? "").trim(),
      internal: false,
    }).returning({ id: replies.id });
    if (attachmentIds.length) {
      await db
        .update(attachments)
        .set({ replyId: first!.id })
        .where(and(
          inArray(attachments.id, attachmentIds),
          isNull(attachments.replyId),
          eq(attachments.uploadedByAccountUserId, user.id),
        ));
    }
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
      log.error("linking replay session_token failed", { scope: "crumb/replay", err });
    }
  }

  // Fire-and-forget AI clustering. Customer doesn't wait for the LLM call
  // — the item is already saved. Errors get swallowed by the helper.
  // Gated on the deployment capability (cloud + key) AND this workspace's
  // plan entitlement.
  if (clusterConfigured() && hasFeature(ws, "ai")) {
    void autoClusterItem(ws, { itemId: created!.id, title: created!.title, body: created!.body, type: created!.type });
  }

  // Fire-and-forget AI auto-triage + embedding (feature 3/4). Same deal: the
  // item is saved, the customer never waits on the 36 GB model's cold-load.
  // Triage + embedding share ONE metered unit (withAiBudget) to bound cost on
  // a path that touches every captured item; clustering above is its own unit.
  if (hasFeature(ws, "ai") && (triageConfigured() || embeddingsConfigured())) {
    void autoTriage(ws, created!.id, created!.title, created!.body, created!.type);
  }

  // Vendor Teams firehose — new submission from the widget (if connected).
  void notifyWorkspaceChannel(ws.id, {
    kind: "new_submission",
    shortId: created!.shortId,
    title: created!.title,
    type: created!.type,
    accountName: account_name ?? "a customer",
    submitterName: user.name,
    url: null,
  });

  return cors(NextResponse.json({
    id: created!.id,
    short_id: created!.shortId,
    status: created!.status,
    created_at: created!.createdAt,
  }, { status: 201 }));
}

// Triage (advisory ai_* columns) + embedding (item_embeddings, for dedup/
// search) under a single metered unit. Best-effort: any failure is swallowed
// — the item is already saved and these are enrichment.
async function autoTriage(
  ws: Workspace,
  itemId: string,
  title: string,
  body: string,
  type: string,
): Promise<void> {
  try {
    const members = await db
      .select({ id: workspaceUsers.id, name: workspaceUsers.name, role: workspaceUsers.role })
      .from(workspaceUsers)
      .where(eq(workspaceUsers.workspaceId, ws.id))
      .limit(50);

    const res = await withAiBudget(ws, async () => {
      const triage = triageConfigured() ? await suggestTriage({ title, body, type }, members) : null;
      const embedding = embeddingsConfigured() ? await embedText(`${title}\n\n${body}`) : null;
      return { triage, embedding };
    });
    if (!res.ok) {
      if (res.error === "ai_cap_reached") {
        log.warn("ai cap reached — skipping autoTriage", { scope: "crumb/ai", workspaceId: ws.id });
      }
      return;
    }

    const { triage, embedding } = res.value;

    if (triage) {
      await db
        .update(items)
        .set({
          aiType: triage.type,
          aiSeverity: triage.severity,
          aiSentiment: triage.sentiment,
          aiUrgency: triage.urgency,
          aiSuggestedAssigneeId: triage.suggestedAssigneeId,
          aiTriageReason: triage.reason,
          aiSummary: triage.summary,
          aiTriagedAt: new Date(),
          aiTriageModel: TRIAGE_MODEL,
          detectedLang: triage.lang,
        })
        .where(eq(items.id, itemId));
    }

    if (embedding) {
      const contentHash = createHash("sha256").update(`${title}\n\n${body}`).digest("hex");
      await db
        .insert(itemEmbeddings)
        .values({
          itemId,
          workspaceId: ws.id,
          embedding,
          model: EMBEDDINGS_MODEL,
          dim: EMBEDDINGS_DIM,
          contentHash,
        })
        .onConflictDoUpdate({
          target: itemEmbeddings.itemId,
          set: { embedding, model: EMBEDDINGS_MODEL, contentHash, updatedAt: new Date() },
        });

      // With the embedding stored, check for a near-duplicate and record a
      // pending suggestion so the inbox arrives pre-flagged (feature 4). Higher
      // bar than the thread's browse threshold to keep the auto-flag quiet.
      try {
        const [best] = await findDuplicateCandidates({
          workspaceId: ws.id,
          itemId,
          limit: 1,
          threshold: DEDUP_SUGGEST_THRESHOLD,
        });
        if (best) {
          await db.insert(dedupeSuggestions).values({
            itemId,
            candidateItemId: best.itemId,
            similarity: best.similarity,
            model: EMBEDDINGS_MODEL,
          });
        }
      } catch (err) {
        log.error("autoDedup failed", { scope: "crumb/ai", err });
      }
    }
  } catch (err) {
    log.error("autoTriage failed", { scope: "crumb/ai", err });
  }
}

// Only auto-flag a duplicate at capture when we're quite sure — keeps the
// inbox chip trustworthy. PMs can still browse looser matches in the thread.
const DEDUP_SUGGEST_THRESHOLD = 0.88;
