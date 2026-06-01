import "server-only";
import { eq } from "drizzle-orm";
import { db, accounts, inboundCaptures, type Workspace } from "@crumb/db";
import { matchAccountConfigured, suggestAccount } from "@/lib/ai/match-account";
import { withAiBudget } from "@/lib/ai/run";
import { hasFeature } from "@/lib/entitlements";
import { log } from "@/lib/log";

// Create a PENDING inbound capture, running the Cloud-only AI account suggester
// first (best-effort, metered). Shared by the forwarded-email webhook and the
// extension API. The capture is reviewed/confirmed at /captures.
export async function createInboundCapture(
  ws: Workspace,
  input: {
    source: "email" | "slack" | "extension";
    fromEmail: string | null;
    fromName: string | null;
    subject: string | null;
    body: string;
    rawMeta?: unknown;
  },
): Promise<string> {
  let suggestion: { accountId: string | null; accountName: string | null; confidence: number } | null = null;
  if (matchAccountConfigured() && hasFeature(ws, "ai")) {
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
      suggestedAccountId: suggestion?.accountId ?? null,
      suggestedAccountName: suggestion?.accountName ?? null,
      suggestedConfidence: suggestion?.confidence ?? null,
      rawMeta: input.rawMeta != null ? JSON.stringify(input.rawMeta) : null,
    })
    .returning({ id: inboundCaptures.id });
  return cap!.id;
}
