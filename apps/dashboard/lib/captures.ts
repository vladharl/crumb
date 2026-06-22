import "server-only";
import { and, eq } from "drizzle-orm";
import { db, accounts, inboundCaptures, type Workspace } from "@crumb/db";
import { matchAccountConfigured, suggestAccount } from "@/lib/ai/match-account";
import { withAiBudget } from "@/lib/ai/run";
import { hasFeature } from "@/lib/entitlements";
import { log } from "@/lib/log";

export type CaptureSource =
  | "email"
  | "slack"
  | "extension"
  | "gong"
  | "zendesk"
  | "intercom"
  | "freshdesk"
  | "freshchat";

export type CaptureInput = {
  source: CaptureSource;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  body: string;
  rawMeta?: unknown;
  // ── Autopilot extras (pulled connectors). Native callers omit these. ──
  externalId?: string | null; // provider record id — idempotency key
  duplicateOfItemId?: string | null;
  duplicateSimilarity?: number | null;
  relevanceScore?: number | null;
  // The gate may land a capture already decided (e.g. accepted+createdItemId for
  // an auto-promote audit row, or dismissed for an irrelevant-but-logged record).
  status?: "pending" | "accepted" | "dismissed";
  createdItemId?: string | null;
  // When the caller already ran the account suggester (the gate does), pass it
  // through to avoid a second metered AI call.
  suggestion?: { accountId: string | null; accountName: string | null; confidence: number } | null;
};

// True if a capture for this provider record already exists — the idempotency
// guard so a re-sync of the same ticket/call never double-ingests. Matches the
// unique (workspace, source, external_id) index.
export async function captureExists(
  ws: Workspace,
  source: CaptureSource,
  externalId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: inboundCaptures.id })
    .from(inboundCaptures)
    .where(
      and(
        eq(inboundCaptures.workspaceId, ws.id),
        eq(inboundCaptures.source, source),
        eq(inboundCaptures.externalId, externalId),
      ),
    )
    .limit(1);
  return !!row;
}

// Create a PENDING inbound capture, running the Cloud-only AI account suggester
// first (best-effort, metered) unless the caller already supplied one. Shared by
// the forwarded-email webhook, the extension API, and the feedback connectors.
// The capture is reviewed/confirmed in the Inbox (the retired /captures tile).
export async function createInboundCapture(ws: Workspace, input: CaptureInput): Promise<string> {
  let suggestion = input.suggestion ?? null;
  if (suggestion === null && matchAccountConfigured() && hasFeature(ws, "ai")) {
    try {
      const rows = await db
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(eq(accounts.workspaceId, ws.id))
        .limit(200);
      const res = await withAiBudget(ws, () =>
        suggestAccount({ fromEmail: input.fromEmail, fromName: input.fromName, subject: input.subject, body: input.body }, rows),
      );
      if (res.ok) suggestion = res.value;
    } catch (err) {
      log.error("inbound account suggest failed", { scope: "crumb/inbound", err });
    }
  }

  const [cap] = await db
    .insert(inboundCaptures)
    .values({
      workspaceId: ws.id,
      source: input.source,
      fromEmail: input.fromEmail,
      fromName: input.fromName,
      subject: input.subject,
      body: input.body,
      externalId: input.externalId ?? null,
      suggestedAccountId: suggestion?.accountId ?? null,
      suggestedAccountName: suggestion?.accountName ?? null,
      suggestedConfidence: suggestion?.confidence ?? null,
      duplicateOfItemId: input.duplicateOfItemId ?? null,
      duplicateSimilarity: input.duplicateSimilarity ?? null,
      relevanceScore: input.relevanceScore ?? null,
      status: input.status ?? "pending",
      createdItemId: input.createdItemId ?? null,
      rawMeta: input.rawMeta != null ? JSON.stringify(input.rawMeta) : null,
    })
    .returning({ id: inboundCaptures.id });
  return cap!.id;
}
