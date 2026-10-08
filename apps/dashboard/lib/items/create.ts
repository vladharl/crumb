import "server-only";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db, workspaces, workspaceUsers, accountUsers, items, itemEmbeddings, dedupeSuggestions, replies, statusEvents, attachments,
  type Item, type ItemContext, type Workspace,
} from "@crumb/db";
import { emitEvent } from "@/lib/webhooks";
import { notifyWorkspaceChannel } from "@/lib/notify/chat";
import { notifyNewSubmission } from "@/lib/vendor-notify";
import { isPulledConnectorSource } from "@/lib/feedback/source";
import { clusterConfigured } from "@/lib/ai/cluster";
import { autoClusterItem } from "@/lib/ai/auto-cluster";
import { suggestTriage, triageConfigured, TRIAGE_MODEL } from "@/lib/ai/triage";
import { embedText, embeddingsConfigured, EMBEDDINGS_MODEL, EMBEDDINGS_DIM } from "@/lib/ai/embeddings";
import { findDuplicateCandidates } from "@/lib/ai/dedup";
import { withAiBudget } from "@/lib/ai/run";
import { hasFeature } from "@/lib/entitlements";
import { log } from "@/lib/log";

// The one way an item is born, whatever the source. The widget POST
// (app/api/v1/items) calls it once it has resolved the identified customer;
// composeItem (lib/compose.ts: dashboard Compose, captures accept, Slack
// /crumb, MCP, Autopilot) once it has upserted the account and submitter.
// Session-free. Bumps the short-id sequence, inserts the item, its "Submitted"
// status event and the seed message, then fires the best-effort side effects,
// none awaited and none able to fail the create: item.created, the Teams
// new-submission post, the vendor new-submission alert, AI clustering, and AI
// triage + embedding (so every source shows up in dedup and Similar items).

type WsForAi = Pick<Workspace, "id" | "planId" | "subscriptionStatus">;

export type CreateItemInput = {
  workspaceId: string;
  accountId: string;
  accountName: string;
  submitterId: string;
  submitterName: string;
  type: string;
  title: string;
  body?: string;
  // Provenance. lib/feedback/source.ts decides from it who may be auto-emailed.
  source?: string | null;
  sourceUrl?: string | null;
  // Widget only: page, browser, app build (capped and redacted by the caller).
  context?: ItemContext | null;
  // The submitter's own uploads not yet on a message, linked to the seed one.
  attachmentIds?: string[];
  // The teammate who logged it for the customer: the opening status event's
  // actor, which also keeps their own new-submission alert away. Unset when the
  // customer wrote it themselves.
  actorWorkspaceUserId?: string | null;
  // The plan AI is gated on. Read off the workspace row when omitted.
  workspace?: WsForAi;
  // false: the item is born a duplicate folded into an existing one (Autopilot),
  // so nothing announces it as new (no item.created, Teams post or
  // new-submission alert) and it isn't clustered.
  announce?: boolean;
  // false: skip AI triage + embedding. Autopilot already extracted and embedded
  // the item under its own autopilot_ai allowance.
  triage?: boolean;
};

// Thrown by createItem when the submitter's feedback was marked as spam
// (account_users.blocked_at, lib/items/delete.ts). Its message is a sentence a
// teammate can be shown; the widget route answers with its own refusal.
export class SubmitterBlockedError extends Error {
  constructor() {
    super("This person's feedback was marked as spam, so new requests from them are turned away.");
    this.name = "SubmitterBlockedError";
  }
}

export async function createItem(input: CreateItemInput): Promise<Item> {
  const title = input.title.trim();
  const body = (input.body ?? "").trim();
  const attachmentIds = input.attachmentIds ?? [];

  // Before anything is written, so a refusal uses no FB number.
  const [submitter] = await db
    .select({ blockedAt: accountUsers.blockedAt })
    .from(accountUsers)
    .where(eq(accountUsers.id, input.submitterId))
    .limit(1);
  if (submitter?.blockedAt) throw new SubmitterBlockedError();

  const [bumped] = await db
    .update(workspaces)
    .set({ nextItemSeq: sql`${workspaces.nextItemSeq} + 1` })
    .where(eq(workspaces.id, input.workspaceId))
    .returning({
      next: workspaces.nextItemSeq,
      slug: workspaces.slug,
      planId: workspaces.planId,
      subscriptionStatus: workspaces.subscriptionStatus,
    });
  const seq = (bumped?.next ?? 1) - 1;
  const shortId = `FB-${seq}`;

  const [created] = await db.insert(items).values({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    submitterId: input.submitterId,
    seq,
    shortId,
    title,
    body,
    type: input.type,
    status: "open",
    source: input.source ?? null,
    sourceUrl: input.sourceUrl ?? null,
    context: input.context ?? null,
  }).returning();

  // The timeline always starts with "Submitted".
  await db.insert(statusEvents).values({
    itemId: created.id,
    fromStatus: null,
    toStatus: "open",
    byWorkspaceUserId: input.actorWorkspaceUserId ?? null,
  });

  // Seed the thread with the customer's own words and the files they attached,
  // linked the way the reply route links them.
  if (body || attachmentIds.length) {
    const [first] = await db
      .insert(replies)
      .values({ itemId: created.id, accountUserId: input.submitterId, body, internal: false })
      .returning({ id: replies.id });
    if (attachmentIds.length) {
      await db
        .update(attachments)
        .set({ replyId: first.id })
        .where(and(
          inArray(attachments.id, attachmentIds),
          isNull(attachments.replyId),
          eq(attachments.uploadedByAccountUserId, input.submitterId),
        ));
    }
  }

  // The insert above can't succeed without the workspace row, so bumped is set.
  const announce = input.announce !== false;
  if (announce) {
    void emitEvent(input.workspaceId, {
      type: "item.created",
      workspace: bumped.slug,
      item: { short_id: shortId, title, type: input.type },
      account: input.accountName,
      at: new Date().toISOString(),
    });
    // Vendor Teams firehose, then each teammate's own new-submission alert.
    void notifyWorkspaceChannel(input.workspaceId, {
      kind: "new_submission",
      shortId,
      title,
      type: input.type,
      accountName: input.accountName,
      submitterName: input.submitterName,
      url: null,
    });
    // Not for Autopilot's connector records: a first sync can promote dozens
    // at once, and one email each would bury the alerts people act on. They
    // land in the inbox and the digest.
    if (!isPulledConnectorSource(input.source)) {
      void notifyNewSubmission({ workspaceId: input.workspaceId, itemId: created.id });
    }
  }

  // AI enrichment: Cloud deployment capability AND the workspace's plan.
  const ws: WsForAi = input.workspace
    ?? { id: input.workspaceId, planId: bumped.planId, subscriptionStatus: bumped.subscriptionStatus };
  if (hasFeature(ws, "ai")) {
    // Initiative suggestion, its own metered unit.
    if (announce && clusterConfigured()) {
      void autoClusterItem(ws, { itemId: created.id, title, body, type: input.type });
    }
    if (input.triage !== false && (triageConfigured() || embeddingsConfigured())) {
      void autoTriage(ws, created.id, title, body, input.type);
    }
  }

  return created;
}

// Triage (advisory ai_* columns) + embedding (item_embeddings, for dedup and
// search) under a single metered unit, to bound cost on a path that touches
// every new item. Best-effort: any failure is swallowed, since the item is
// already saved and these are enrichment.
async function autoTriage(ws: WsForAi, itemId: string, title: string, body: string, type: string): Promise<void> {
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
        .values({ itemId, workspaceId: ws.id, embedding, model: EMBEDDINGS_MODEL, dim: EMBEDDINGS_DIM, contentHash })
        .onConflictDoUpdate({
          target: itemEmbeddings.itemId,
          set: { embedding, model: EMBEDDINGS_MODEL, contentHash, updatedAt: new Date() },
        });

      // With the embedding stored, check for a near-duplicate and record a
      // pending suggestion so the inbox arrives pre-flagged.
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

// Only auto-flag a duplicate at capture when we're quite sure, which keeps the
// inbox chip trustworthy. PMs can still browse looser matches in the thread.
const DEDUP_SUGGEST_THRESHOLD = 0.88;
