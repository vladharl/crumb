import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, workspaces, accounts, accountUsers, items, replies, statusEvents } from "@crumb/db";
import type { Workspace } from "@crumb/db";
import { notifyWorkspaceChannel } from "@/lib/notify/chat";
import { clusterConfigured } from "@/lib/ai/cluster";
import { autoClusterItem } from "@/lib/ai/auto-cluster";
import { hasFeature } from "@/lib/entitlements";
import { emitEvent } from "@/lib/webhooks";

// Session-free core of "create an item on behalf of a customer" — upsert the
// account + submitter, bump the per-workspace short-id sequence, insert the
// item + initial status event + seed reply. Used by:
//   - the dashboard Compose panel (compose-actions.ts, after getActiveSession)
//   - captures accept (app/(app)/captures/actions.ts)
//   - the Slack slash-command interactivity route (no dashboard session there)
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
  // Inbound provenance (Autopilot). Native callers leave these unset; the
  // feedback connectors pass source = gong|zendesk|… and a deep-link back to
  // the originating call/ticket so the inbox can badge + link the item.
  source?: string;
  sourceUrl?: string | null;
  // When provided (dashboard paths have the full Workspace), the new item gets
  // an AI initiative suggestion like widget submissions do. Omitted on the
  // session-free Slack path, which simply skips clustering.
  workspace?: Pick<Workspace, "id" | "planId" | "subscriptionStatus">;
  // false skips the item.created webhook and the Teams new-submission post:
  // Autopilot folds the item into an existing one as a duplicate right away.
  announce?: boolean;
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

  const [bumped] = await db
    .update(workspaces)
    .set({ nextItemSeq: sql`${workspaces.nextItemSeq} + 1` })
    .where(eq(workspaces.id, input.workspaceId))
    .returning({ next: workspaces.nextItemSeq, slug: workspaces.slug });
  const seq = (bumped?.next ?? 1) - 1;
  const shortId = `FB-${seq}`;

  const [created] = await db.insert(items).values({
    workspaceId: input.workspaceId,
    accountId: account.id,
    submitterId: submitter.id,
    seq,
    shortId,
    title,
    body,
    type: input.type,
    status: "open",
    source: input.source ?? null,
    sourceUrl: input.sourceUrl ?? null,
  }).returning();

  await db.insert(statusEvents).values({ itemId: created!.id, fromStatus: null, toStatus: "open" });
  if (body) {
    await db.insert(replies).values({ itemId: created!.id, accountUserId: submitter.id, body, internal: false });
  }

  // Outbound webhook fan-out: item.created (covers compose, Slack, capture-accept).
  const announce = input.announce !== false;
  if (announce && bumped?.slug) {
    void emitEvent(input.workspaceId, {
      type: "item.created",
      workspace: bumped.slug,
      item: { short_id: shortId, title, type: input.type },
      account: accountName,
      at: new Date().toISOString(),
    });
  }

  // Vendor Teams firehose: new submission (covers compose, Slack, capture-accept).
  if (announce) {
    void notifyWorkspaceChannel(input.workspaceId, {
      kind: "new_submission",
      shortId,
      title,
      type: input.type,
      accountName,
      submitterName,
      url: null,
    });
  }

  // Fire-and-forget AI clustering, matching the widget path. Only when the
  // caller passed the workspace (dashboard sessions); no-ops on self-host.
  if (input.workspace && clusterConfigured() && hasFeature(input.workspace, "ai")) {
    void autoClusterItem(input.workspace, { itemId: created!.id, title, body, type: input.type });
  }

  return { ok: true, shortId, itemId: created!.id, accountId: account.id, accountName };
}
