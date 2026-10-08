"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, accounts, accountUsers, items } from "@crumb/db";
import { requireSession } from "@/lib/auth";

const MAX_NAME = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function canManage(role: string): boolean {
  return role === "admin" || role === "pm";
}

function initialsFor(source: string): string {
  const parts = source.split(/\s+|@/).filter(Boolean).slice(0, 2);
  return (parts.map(s => s[0]?.toUpperCase() ?? "").join("") || "?").slice(0, 4);
}

export type CreateAccountResult = { ok: true; id: string; name: string } | { ok: false; error: string };

export async function createAccount(formData: FormData): Promise<CreateAccountResult> {
  const { workspace, user } = await requireSession();
  if (!canManage(user.role)) return { ok: false, error: "Only admins and PMs can manage accounts." };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Account name is required." };
  if (name.length > MAX_NAME) return { ok: false, error: "Name is too long." };

  const [created] = await db
    .insert(accounts)
    .values({ workspaceId: workspace.id, name })
    .returning({ id: accounts.id, name: accounts.name });
  revalidatePath("/settings/account-mapping");
  revalidatePath("/accounts");
  return { ok: true, id: created!.id, name: created!.name };
}

export type MutationResult = { ok: true } | { ok: false; error: string };

export async function renameAccount(id: string, name: string): Promise<MutationResult> {
  const { workspace, user } = await requireSession();
  if (!canManage(user.role)) return { ok: false, error: "Only admins and PMs can manage accounts." };
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Account name is required." };
  if (trimmed.length > MAX_NAME) return { ok: false, error: "Name is too long." };
  const r = await db
    .update(accounts)
    .set({ name: trimmed })
    .where(and(eq(accounts.id, id), eq(accounts.workspaceId, workspace.id)))
    .returning({ id: accounts.id });
  if (r.length === 0) return { ok: false, error: "Account not found." };
  revalidatePath("/settings/account-mapping");
  revalidatePath("/accounts");
  return { ok: true };
}

export async function deleteAccount(id: string): Promise<MutationResult> {
  const { workspace, user } = await requireSession();
  if (!canManage(user.role)) return { ok: false, error: "Only admins and PMs can manage accounts." };

  // Deleting an account cascades to its items (FK on items.account_id) — refuse
  // when feedback exists so we never silently destroy a thread. Reassign or keep.
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(items)
    .where(and(eq(items.workspaceId, workspace.id), eq(items.accountId, id)));
  if (n > 0) return { ok: false, error: `Account still has ${n} request${n === 1 ? "" : "s"}. Reassign or delete those first.` };

  await db.delete(accounts).where(and(eq(accounts.id, id), eq(accounts.workspaceId, workspace.id)));
  revalidatePath("/settings/account-mapping");
  revalidatePath("/accounts");
  return { ok: true };
}

// "Override user" — move a customer user (and their existing items) onto a
// different account, fixing a mis-mapping from the widget's auto-create.
export async function reassignUser(accountUserId: string, toAccountId: string): Promise<MutationResult> {
  const { workspace, user } = await requireSession();
  if (!canManage(user.role)) return { ok: false, error: "Only admins and PMs can manage accounts." };

  const [target] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, toAccountId), eq(accounts.workspaceId, workspace.id)))
    .limit(1);
  if (!target) return { ok: false, error: "Target account not found." };

  const r = await db
    .update(accountUsers)
    .set({ accountId: toAccountId })
    .where(and(eq(accountUsers.id, accountUserId), eq(accountUsers.workspaceId, workspace.id)))
    .returning({ id: accountUsers.id });
  if (r.length === 0) return { ok: false, error: "User not found." };

  // Keep items consistent with the user's new account.
  await db
    .update(items)
    .set({ accountId: toAccountId })
    .where(and(eq(items.workspaceId, workspace.id), eq(items.submitterId, accountUserId)));

  revalidatePath("/settings/account-mapping");
  revalidatePath("/accounts");
  return { ok: true };
}

// ─── CSV import ──────────────────────────────────────────────
// Minimal RFC-4180-ish parser (handles quoted fields + escaped quotes).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ""));
}

export type ImportResult =
  | { ok: true; accountsCreated: number; usersCreated: number; usersUpdated: number; skipped: number }
  | { ok: false; error: string };

// Columns: account_name, email, [name]. A header row (if its first cell looks
// like a header) is skipped.
export async function importAccountsCsv(text: string): Promise<ImportResult> {
  const { workspace, user } = await requireSession();
  if (!canManage(user.role)) return { ok: false, error: "Only admins and PMs can manage accounts." };

  let rows = parseCsv(text);
  if (rows.length === 0) return { ok: false, error: "No rows found in the file." };
  const first = rows[0]!.map(c => c.trim().toLowerCase());
  if (first[0] === "account_name" || first[0] === "account" || first.includes("email")) rows = rows.slice(1);
  if (rows.length === 0) return { ok: false, error: "No data rows after the header." };
  if (rows.length > 5000) return { ok: false, error: "Too many rows (max 5000 per import)." };

  // Cache accounts by name so repeated names in the file reuse one row.
  const existingAccounts = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.workspaceId, workspace.id));
  const accountByName = new Map(existingAccounts.map(a => [a.name.toLowerCase(), a.id]));

  let accountsCreated = 0, usersCreated = 0, usersUpdated = 0, skipped = 0;
  for (const cols of rows) {
    const accountName = (cols[0] ?? "").trim();
    const email = (cols[1] ?? "").trim().toLowerCase();
    const name = (cols[2] ?? "").trim();
    if (!accountName || accountName.length > MAX_NAME || !EMAIL_RE.test(email)) { skipped++; continue; }

    let accountId = accountByName.get(accountName.toLowerCase());
    if (!accountId) {
      const [a] = await db.insert(accounts).values({ workspaceId: workspace.id, name: accountName }).returning({ id: accounts.id });
      accountId = a!.id;
      accountByName.set(accountName.toLowerCase(), accountId);
      accountsCreated++;
    }

    const display = name || email.split("@")[0]!;
    const [existing] = await db
      .select({ id: accountUsers.id })
      .from(accountUsers)
      .where(and(eq(accountUsers.workspaceId, workspace.id), eq(accountUsers.email, email)))
      .limit(1);
    if (existing) {
      await db.update(accountUsers).set({ accountId, name: display }).where(eq(accountUsers.id, existing.id));
      usersUpdated++;
    } else {
      await db.insert(accountUsers).values({
        workspaceId: workspace.id,
        accountId,
        email,
        name: display,
        initials: initialsFor(name || email),
      });
      usersCreated++;
    }
  }

  revalidatePath("/settings/account-mapping");
  revalidatePath("/accounts");
  return { ok: true, accountsCreated, usersCreated, usersUpdated, skipped };
}
