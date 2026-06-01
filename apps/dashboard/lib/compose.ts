import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, workspaces, accounts, accountUsers, items, replies, statusEvents } from "@crumb/db";
import { notifyWorkspaceChannel } from "@/lib/notify/chat";

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
    .returning({ next: workspaces.nextItemSeq });
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
  }).returning();

  await db.insert(statusEvents).values({ itemId: created!.id, fromStatus: null, toStatus: "open" });
  if (body) {
    await db.insert(replies).values({ itemId: created!.id, accountUserId: submitter.id, body, internal: false });
  }

  // Vendor Teams firehose — new submission (covers compose, Slack, capture-accept).
  void notifyWorkspaceChannel(input.workspaceId, {
    kind: "new_submission",
    shortId,
    title,
    type: input.type,
    accountName,
    submitterName,
    url: null,
  });

  return { ok: true, shortId, itemId: created!.id, accountId: account.id, accountName };
}
