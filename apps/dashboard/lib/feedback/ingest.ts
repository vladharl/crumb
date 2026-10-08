import "server-only";
import { createHash } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import {
  db,
  accounts,
  accountUsers,
  items,
  itemEmbeddings,
  inboundCaptures,
  tags as tagsTable,
  itemTags,
  replies,
  type Workspace,
} from "@crumb/db";
import { composeItem } from "@/lib/compose";
import { createInboundCapture, type CaptureSource } from "@/lib/captures";
import { extractFeedback, extractConfigured, EXTRACT_MODEL, type ExtractedUnit } from "@/lib/ai/extract-feedback";
import { embedText, embeddingsConfigured, EMBEDDINGS_MODEL, EMBEDDINGS_DIM } from "@/lib/ai/embeddings";
import { findDuplicatesForVector } from "@/lib/ai/dedup";
import type { AiBudgetResult } from "@/lib/ai/run";
import { hasFeature } from "@/lib/entitlements";
import { isBlockedSender } from "@/lib/items/delete";
import { aiCap, currentPeriod } from "@/lib/usage";
import { log } from "@/lib/log";
import type { FeedbackRecord } from "@/lib/integrations/feedback/types";
import { classifyUnit, getThresholds, compositeType, modeForSource, unitExternalId, titleCase } from "@/lib/feedback/decision";

// ─── The Autopilot "new & relevant?" decision engine ─────────────────────────
//
// Turns one pulled record (ticket / chat / call) into the right inbox outcome:
//
//   relevance < FLOOR              → DROP   (dismissed marker; not real feedback)
//   similarity ≥ MERGE             → ATTACH (not new — fold into the canonical item)
//   novel + high-confidence + email → PROMOTE (create the item automatically)
//   otherwise                       → HOLD   (PENDING capture for human review)
//
// Cloud-only AI does the work (extraction + embedding dedup), paid from
// Autopilot's own allowance (withAutopilotBudget). On self-host (or when AI
// isn't entitled / the allowance is spent) every record lands as a raw PENDING
// capture — nothing is silently lost.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type IngestOutcome = { promoted: number; attached: number; held: number; dropped: number; skipped: number };

function emptyOutcome(): IngestOutcome {
  return { promoted: 0, attached: 0, held: 0, dropped: 0, skipped: 0 };
}

// Autopilot's AI runs on its own monthly allowance: usage_counters metric
// "autopilot_ai", the same size as the plan's AI allowance (aiCap, which
// CRUMB_AI_MONTHLY_CAP overrides) but counted apart from the "ai" metric that
// triage, Ask, drafts and clustering share, so a connector backlog can't use
// those up for the month. One unit per extraction, one per embedding. Past the
// allowance, records land raw in the Inbox for review.
// ponytail: consumeAi's atomic upsert under another metric. Fold it into
// consumeAi(ws, metric) once lib/usage.ts takes one, and show the metric in the
// billing page's usage summary.
export async function withAutopilotBudget<T>(
  ws: Pick<Workspace, "id" | "planId" | "subscriptionStatus">,
  fn: () => Promise<T>,
): Promise<AiBudgetResult<T>> {
  if (!hasFeature(ws, "ai")) return { ok: false, error: "not_entitled" };
  const rows = await db.execute(sql`
    insert into usage_counters (workspace_id, metric, period, count)
    values (${ws.id}::uuid, 'autopilot_ai', ${currentPeriod()}, 1)
    on conflict (workspace_id, metric, period)
    do update set count = usage_counters.count + 1, updated_at = now()
    where usage_counters.count < ${aiCap(ws)}
    returning count
  `);
  if ((rows as unknown as unknown[]).length === 0) return { ok: false, error: "ai_cap_reached" };
  return { ok: true, value: await fn() };
}

// Have we already processed THIS provider record (any of its units)? Guards
// against re-extracting a record that a later sync re-surfaces after an update.
async function recordAlreadyIngested(ws: Workspace, source: CaptureSource, recordExternalId: string): Promise<boolean> {
  // Escape LIKE metacharacters so an id containing % / _ / \ can't widen the match.
  const prefix = recordExternalId.replace(/([%_\\])/g, "\\$1") + "#%";
  const [row] = await db
    .select({ id: inboundCaptures.id })
    .from(inboundCaptures)
    .where(
      and(
        eq(inboundCaptures.workspaceId, ws.id),
        eq(inboundCaptures.source, source),
        like(inboundCaptures.externalId, prefix),
      ),
    )
    .limit(1);
  return !!row;
}

// Cheap, non-AI account resolution so the gate doesn't spend an AI unit per unit
// just to map an account. Exact email/name matches are high-confidence; an email
// domain is a low-confidence fallback name a human can correct on the capture.
async function resolveAccount(
  ws: Workspace,
  record: FeedbackRecord,
): Promise<{ accountId: string | null; accountName: string | null; confidence: number }> {
  const email = record.authorEmail?.trim().toLowerCase();
  if (email && EMAIL_RE.test(email)) {
    const [au] = await db
      .select({ accountId: accountUsers.accountId, name: accounts.name })
      .from(accountUsers)
      .innerJoin(accounts, eq(accounts.id, accountUsers.accountId))
      .where(and(eq(accountUsers.workspaceId, ws.id), eq(accountUsers.email, email)))
      .limit(1);
    if (au) return { accountId: au.accountId, accountName: au.name, confidence: 0.95 };
    const domain = email.split("@")[1] ?? "";
    const root = domain.split(".")[0] ?? "";
    return { accountId: null, accountName: root ? titleCase(root) : null, confidence: 0.3 };
  }
  const name = record.authorName?.trim();
  if (name) {
    const [acc] = await db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.workspaceId, ws.id), eq(accounts.name, name)))
      .limit(1);
    if (acc) return { accountId: acc.id, accountName: acc.name, confidence: 0.6 };
  }
  return { accountId: null, accountName: name ?? null, confidence: 0.1 };
}

// Store the embedding, write advisory AI fields, and apply auto-tags for a newly
// promoted item. Mirrors the autoTriage enrichment in lib/items/create.ts (which
// composeItem skips here, triage: false), but reuses the extraction we already
// have instead of a second model call.
async function enrichPromotedItem(
  ws: Workspace,
  itemId: string,
  unit: ExtractedUnit,
  embedding: number[] | null,
): Promise<void> {
  try {
    if (embedding) {
      const contentHash = createHash("sha256").update(`${unit.title}\n\n${unit.body}`).digest("hex");
      await db
        .insert(itemEmbeddings)
        .values({ itemId, workspaceId: ws.id, embedding, model: EMBEDDINGS_MODEL, dim: EMBEDDINGS_DIM, contentHash })
        .onConflictDoUpdate({
          target: itemEmbeddings.itemId,
          set: { embedding, model: EMBEDDINGS_MODEL, contentHash, updatedAt: new Date() },
        });
    }
    await db
      .update(items)
      .set({
        aiType: unit.type,
        aiSeverity: unit.severity,
        aiSummary: unit.title,
        aiTriageReason: "Extracted from inbound feedback",
        aiTriagedAt: new Date(),
        aiTriageModel: EXTRACT_MODEL,
      })
      .where(eq(items.id, itemId));
    await applyTags(ws, itemId, unit.tags);
  } catch (err) {
    log.error("autopilot enrich failed", { scope: "crumb/autopilot", err });
  }
}

// Upsert tags by name and link them to an item, marked 'ai' so the UI can show
// them as auto-applied. Idempotent on both the tag name and the item↔tag link.
export async function applyTags(ws: Workspace, itemId: string, names: string[]): Promise<void> {
  for (const raw of names) {
    const name = raw.trim().toLowerCase().slice(0, 64);
    if (!name) continue;
    await db.insert(tagsTable).values({ workspaceId: ws.id, name }).onConflictDoNothing();
    const [tag] = await db
      .select({ id: tagsTable.id })
      .from(tagsTable)
      .where(and(eq(tagsTable.workspaceId, ws.id), eq(tagsTable.name, name)))
      .limit(1);
    if (tag) {
      await db.insert(itemTags).values({ itemId, tagId: tag.id, source: "ai" }).onConflictDoNothing();
    }
  }
}

// Attach an inbound signal to an existing canonical item (the "not new" path).
// When we have a usable submitter we create a duplicate item folded into the
// canonical — this grows the canonical's reach/ARR-at-stake via the existing
// merge-group aggregation. Otherwise we just leave an internal note. Either way
// no new open loop, the customer is not emailed, and nothing announces it as
// new (announce: false: no item.created, Teams post, new-submission alert or AI
// clustering). triage: false, since its text was already extracted and embedded.
async function attachToCanonical(
  ws: Workspace,
  source: CaptureSource,
  record: FeedbackRecord,
  unit: ExtractedUnit,
  canonicalItemId: string,
  account: { accountName: string | null },
): Promise<string | null> {
  const email = record.authorEmail?.trim().toLowerCase();
  const link = record.url ? ` (${record.url})` : "";
  const note = `Also raised via ${titleCase(source)}${link}: "${unit.title}"`;

  if (email && EMAIL_RE.test(email) && account.accountName) {
    const r = await composeItem({
      workspaceId: ws.id,
      accountName: account.accountName,
      submitterEmail: email,
      submitterName: record.authorName ?? undefined,
      type: compositeType(unit.type),
      title: unit.title,
      body: unit.body,
      source,
      sourceUrl: record.url,
      announce: false,
      triage: false,
    });
    if (r.ok) {
      await db
        .update(items)
        .set({ mergedIntoId: canonicalItemId, mergedAt: new Date(), status: "duplicate" })
        .where(eq(items.id, r.itemId));
      await db.insert(replies).values({ itemId: canonicalItemId, body: note, internal: true });
      return r.itemId;
    }
  }
  // Fallback: corroborate on the canonical with an internal note only.
  await db.insert(replies).values({ itemId: canonicalItemId, body: note, internal: true });
  return null;
}

// Ingest a single pulled record. Returns its per-record outcome counts.
export async function ingestRecord(
  ws: Workspace,
  source: CaptureSource,
  record: FeedbackRecord,
): Promise<IngestOutcome> {
  const out = emptyOutcome();
  if (!record.externalId) return out;

  if (await recordAlreadyIngested(ws, source, record.externalId)) {
    out.skipped++;
    return out;
  }
  // From someone whose feedback was marked as spam: nothing is kept, not even
  // an "Also raised via" note, and no AI is spent. No marker either, so a
  // record that resurfaces after they're unblocked comes in.
  if (await isBlockedSender(ws.id, record.authorEmail)) {
    out.skipped++;
    return out;
  }

  const account = await resolveAccount(ws, record);
  const suggestion = { accountId: account.accountId, accountName: account.accountName, confidence: account.confidence };
  const rawMeta = { url: record.url, occurredAt: record.occurredAt?.toISOString() ?? null, ...record.raw };

  // Self-host / not entitled: land the whole record raw for manual review.
  if (!(extractConfigured() && hasFeature(ws, "ai"))) {
    await createInboundCapture(ws, {
      source,
      fromEmail: record.authorEmail,
      fromName: record.authorName,
      subject: record.subject,
      body: record.text,
      externalId: unitExternalId(record.externalId, 0),
      suggestion,
      rawMeta,
    });
    out.held++;
    return out;
  }

  const res = await withAutopilotBudget(ws, () =>
    extractFeedback({ mode: modeForSource(source), subject: record.subject, text: record.text }),
  );
  if (!res.ok || res.value === null) {
    // Allowance spent / not entitled / model error → never drop silently: hold raw.
    await createInboundCapture(ws, {
      source,
      fromEmail: record.authorEmail,
      fromName: record.authorName,
      subject: record.subject,
      body: record.text,
      externalId: unitExternalId(record.externalId, 0),
      suggestion,
      rawMeta,
    });
    out.held++;
    return out;
  }

  const units = res.value;
  if (units.length === 0) {
    // No feedback in this record — write a dismissed marker so a re-sync of the
    // same record doesn't re-run extraction.
    await createInboundCapture(ws, {
      source,
      fromEmail: record.authorEmail,
      fromName: record.authorName,
      subject: record.subject,
      body: record.text.slice(0, 2000),
      externalId: unitExternalId(record.externalId, 0),
      status: "dismissed",
      relevanceScore: 0,
      suggestion,
      rawMeta,
    });
    out.dropped++;
    return out;
  }

  const t = getThresholds();
  const email = record.authorEmail?.trim().toLowerCase();
  const hasValidEmail = !!email && EMAIL_RE.test(email);
  const hasAccountName = !!account.accountName;

  for (let idx = 0; idx < units.length; idx++) {
    const unit = units[idx]!;
    const extId = unitExternalId(record.externalId, idx);

    // Cheap early drop: skip embedding for clearly-irrelevant units.
    if (unit.relevance < t.relevanceFloor) {
      await createInboundCapture(ws, {
        source, fromEmail: record.authorEmail, fromName: record.authorName,
        subject: unit.title, body: unit.body, externalId: extId,
        status: "dismissed", relevanceScore: unit.relevance, suggestion, rawMeta,
      });
      out.dropped++;
      continue;
    }

    // Embed for the "new?" check (metered; on cap, fall back to no-dedup hold).
    let embedding: number[] | null = null;
    if (embeddingsConfigured()) {
      const er = await withAutopilotBudget(ws, () => embedText(`${unit.title}\n\n${unit.body}`));
      if (er.ok) embedding = er.value;
    }
    const candidates = embedding
      ? await findDuplicatesForVector({ workspaceId: ws.id, vec: embedding, limit: 1, threshold: t.suggest })
      : [];
    const best = candidates[0];
    const sim = best?.similarity ?? 0;

    let decision = classifyUnit(
      { relevance: unit.relevance, confidence: unit.confidence, similarity: sim, hasMatch: !!best, hasValidEmail, hasAccountName },
      t,
    );
    // The duplicate check couldn't run (allowance spent or the embedder failed),
    // so "novel" is unproven: a person decides instead of auto-promoting.
    if (decision === "promote" && embeddingsConfigured() && !embedding) decision = "hold";

    if (decision === "drop") {
      await createInboundCapture(ws, {
        source, fromEmail: record.authorEmail, fromName: record.authorName,
        subject: unit.title, body: unit.body, externalId: extId,
        status: "dismissed", relevanceScore: unit.relevance, suggestion, rawMeta,
      });
      out.dropped++;
      continue;
    }

    // ATTACH: a near-identical item already exists → not new.
    if (decision === "attach" && best) {
      const dupItemId = await attachToCanonical(ws, source, record, unit, best.itemId, account);
      await createInboundCapture(ws, {
        source, fromEmail: record.authorEmail, fromName: record.authorName,
        subject: unit.title, body: unit.body, externalId: extId,
        status: "accepted", createdItemId: dupItemId ?? best.itemId,
        duplicateOfItemId: best.itemId, duplicateSimilarity: sim,
        relevanceScore: unit.relevance, suggestion, rawMeta,
      });
      out.attached++;
      continue;
    }

    // PROMOTE: confident, novel, mappable → create the item now.
    if (decision === "promote") {
      const r = await composeItem({
        workspaceId: ws.id, workspace: ws,
        accountName: account.accountName!, submitterEmail: email!,
        submitterName: record.authorName ?? undefined,
        type: compositeType(unit.type), title: unit.title, body: unit.body,
        source, sourceUrl: record.url,
        // Extracted + embedded above under autopilot_ai; enrichPromotedItem stores it.
        triage: false,
      });
      if (r.ok) {
        await enrichPromotedItem(ws, r.itemId, unit, embedding);
        await createInboundCapture(ws, {
          source, fromEmail: record.authorEmail, fromName: record.authorName,
          subject: unit.title, body: unit.body, externalId: extId,
          status: "accepted", createdItemId: r.itemId,
          relevanceScore: unit.relevance, suggestion, rawMeta,
        });
        out.promoted++;
        continue;
      }
      decision = "hold"; // composeItem rejected (bad email/name) → fall back.
    }

    // HOLD: borderline duplicate, low confidence, or unmappable → human review.
    await createInboundCapture(ws, {
      source, fromEmail: record.authorEmail, fromName: record.authorName,
      subject: unit.title, body: unit.body, externalId: extId,
      status: "pending",
      duplicateOfItemId: best?.itemId ?? null,
      duplicateSimilarity: best ? sim : null,
      relevanceScore: unit.relevance, suggestion, rawMeta,
    });
    out.held++;
  }

  return out;
}
