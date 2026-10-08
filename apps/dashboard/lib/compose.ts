import "server-only";
import { and, eq } from "drizzle-orm";
import { db, accounts, accountUsers } from "@crumb/db";
import type { Workspace } from "@crumb/db";
import { createItem } from "@/lib/items/create";

// Session-free "create an item on behalf of a customer": upsert the account +
// submitter, then hand off to createItem (lib/items/create.ts), the core every
// source shares (sequence, item, status event, seed reply, announcements, AI).
// Used by:
//   - the dashboard Compose panel (compose-actions.ts, after getActiveSession)
//   - captures accept (app/(app)/captures/actions.ts)
//   - the Slack slash-command interactivity route (no dashboard session there)
//   - the MCP create_item tool, and Autopilot (lib/feedback/ingest.ts)
// Always satisfies items.account_id / submitter_id NOT NULL.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const COMPOSE_ALLOWED_TYPES = new Set(["bug", "idea", "question"]);

export type ComposeItemResult =
  | { ok: true; shortId: string; itemId: string; accountId: string; accountName: string }
  | { ok: false; error: string };

export async function composeItem(input: {
  workspaceId: string;
  accountName: string;
  submitterEmail: string;
  submitterName?: string;
  type: string;
  title: string;
  body?: string;
  // Provenance (lib/feedback/source.ts decides who may be auto-emailed).
  // Dashboard Compose leaves it unset; Slack /crumb and MCP pass slack | mcp;
  // the feedback connectors pass gong|zendesk|… and a deep-link back to the
  // originating call/ticket so the inbox can badge + link the item.
  source?: string;
  sourceUrl?: string | null;
  // The plan AI enrichment is gated on. createItem reads it when omitted.
  workspace?: Pick<Workspace, "id" | "planId" | "subscriptionStatus">;
  // false: Autopilot folds the item into an existing one as a duplicate right
  // away, so nothing announces it as new and it isn't clustered.
  announce?: boolean;
  // false: skip AI triage + embedding (Autopilot ran its own extraction).
  triage?: boolean;
  // The teammate logging it, when there is one (see createItem).
  actorWorkspaceUserId?: string | null;
}): Promise<ComposeItemResult> {
  const accountName = input.accountName.trim();
  const submitterEmail = input.submitterEmail.trim().toLowerCase();
  const submitterName = input.submitterName?.trim() || submitterEmail.split("@")[0]!;
  const title = input.title.trim();
  const body = (input.body ?? "").trim();

  if (!accountName) return { ok: false, error: "Account is required." };
  if (!EMAIL_RE.test(submitterEmail)) return { ok: false, error: "Enter a valid email for the submitter." };
  if (!COMPOSE_ALLOWED_TYPES.has(input.type)) return { ok: false, error: "Pick a type." };
  if (!title) return { ok: false, error: "Title is required." };

  // Upsert account
  let [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.workspaceId, input.workspaceId), eq(accounts.name, accountName)))
    .limit(1);
  if (!account) {
    const inserted = await db.insert(accounts).values({ workspaceId: input.workspaceId, name: accountName }).returning();
    account = inserted[0]!;
  }

  // Upsert submitter
  let [submitter] = await db
    .select()
    .from(accountUsers)
    .where(and(eq(accountUsers.workspaceId, input.workspaceId), eq(accountUsers.email, submitterEmail)))
    .limit(1);
  if (!submitter) {
    const initials = submitterName
      .split(/\s+|@/).filter(Boolean).slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? "").join("") || "?";
    const inserted = await db.insert(accountUsers).values({
      workspaceId: input.workspaceId,
      accountId: account.id,
      email: submitterEmail,
      name: submitterName,
      initials: initials.slice(0, 4),
    }).returning();
    submitter = inserted[0]!;
  }

  const created = await createItem({
    workspaceId: input.workspaceId,
    workspace: input.workspace,
    accountId: account.id,
    accountName,
    submitterId: submitter.id,
    submitterName,
    type: input.type,
    title,
    body,
    source: input.source,
    sourceUrl: input.sourceUrl,
    announce: input.announce,
    triage: input.triage,
    actorWorkspaceUserId: input.actorWorkspaceUserId,
  });

  return { ok: true, shortId: created.shortId, itemId: created.id, accountId: account.id, accountName };
}
