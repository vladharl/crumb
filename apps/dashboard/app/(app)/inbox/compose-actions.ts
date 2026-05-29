"use server";

import { and, eq, sql } from "drizzle-orm";
import { db, workspaces, accounts, accountUsers, items, replies, statusEvents } from "@crumb/db";
import { revalidatePath } from "next/cache";
import { getActiveSession } from "@/lib/server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_TYPES = new Set(["bug", "idea", "question"]);

export type ComposeResult =
  | { ok: true; shortId: string }
  | { ok: false; error: string };

export async function composeOnBehalf(input: {
  accountName: string;
  submitterEmail: string;
  submitterName?: string;
  type: string;
  title: string;
  body?: string;
}): Promise<ComposeResult> {
  const { workspace } = await getActiveSession();

  const accountName = input.accountName.trim();
  const submitterEmail = input.submitterEmail.trim().toLowerCase();
  const submitterName = input.submitterName?.trim() || submitterEmail.split("@")[0]!;
  const title = input.title.trim();
  const body = (input.body ?? "").trim();

  if (!accountName) return { ok: false, error: "Account is required." };
  if (!EMAIL_RE.test(submitterEmail)) return { ok: false, error: "Enter a valid email for the submitter." };
  if (!ALLOWED_TYPES.has(input.type)) return { ok: false, error: "Pick a type." };
  if (!title) return { ok: false, error: "Title is required." };

  // Upsert account
  let [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspace.id), eq(accounts.name, accountName)))
    .limit(1);
  if (!account) {
    const inserted = await db.insert(accounts).values({ workspaceId: workspace.id, name: accountName }).returning();
    account = inserted[0]!;
  }

  // Upsert submitter
  let [submitter] = await db
    .select()
    .from(accountUsers)
    .where(and(eq(accountUsers.workspaceId, workspace.id), eq(accountUsers.email, submitterEmail)))
    .limit(1);
  if (!submitter) {
    const initials = submitterName
      .split(/\s+|@/).filter(Boolean).slice(0, 2)
      .map(s => s[0]?.toUpperCase() ?? "").join("") || "?";
    const inserted = await db.insert(accountUsers).values({
      workspaceId: workspace.id,
      accountId: account.id,
      email: submitterEmail,
      name: submitterName,
      initials: initials.slice(0, 4),
    }).returning();
    submitter = inserted[0]!;
  }

  // Atomic per-workspace short-id sequence — same shape as the public API.
  const [bumped] = await db
    .update(workspaces)
    .set({ nextItemSeq: sql`${workspaces.nextItemSeq} + 1` })
    .where(eq(workspaces.id, workspace.id))
    .returning({ next: workspaces.nextItemSeq });
  const seq = (bumped?.next ?? 1) - 1;
  const shortId = `FB-${seq}`;

  const [created] = await db.insert(items).values({
    workspaceId: workspace.id,
    accountId: account.id,
    submitterId: submitter.id,
    seq,
    shortId,
    title,
    body,
    type: input.type,
    status: "open",
  }).returning();

  await db.insert(statusEvents).values({
    itemId: created!.id,
    fromStatus: null,
    toStatus: "open",
  });

  if (body) {
    await db.insert(replies).values({
      itemId: created!.id,
      accountUserId: submitter.id,
      body,
      internal: false,
    });
  }

  revalidatePath("/inbox");
  return { ok: true, shortId };
}
