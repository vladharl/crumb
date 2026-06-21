import { randomBytes } from "node:crypto";
import { and, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { db } from "./client";
import { pendingSignups, type PendingSignup } from "./schema";

// Default validity for a self-serve signup verification link. Short, like a
// magic link — the visitor is expected to click it right after signing up.
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export type PendingSignupInput = {
  workspaceName: string;
  slug: string;
  adminName: string;
  adminEmail: string;
  ip?: string | null;
  ttlMs?: number;
};

// Mint a single-use, email-verification token carrying the pending workspace
// details. The workspace is created only when this token is consumed (the
// visitor clicks the verify link), so an unverified email never mints one.
export async function createPendingSignup(input: PendingSignupInput): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await db.insert(pendingSignups).values({
    token,
    workspaceName: input.workspaceName,
    slug: input.slug,
    adminName: input.adminName,
    adminEmail: input.adminEmail,
    ip: input.ip ?? null,
    expiresAt: new Date(Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS)),
  });
  return token;
}

// Resolve a token to its row iff it exists, is unconsumed, and unexpired.
export async function findValidPendingSignup(token: string): Promise<PendingSignup | null> {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(pendingSignups)
    .where(and(
      eq(pendingSignups.token, token),
      isNull(pendingSignups.consumedAt),
      gt(pendingSignups.expiresAt, new Date()),
    ))
    .limit(1);
  return row ?? null;
}

// Burn a token so its link can't be reused.
export async function consumePendingSignup(id: string): Promise<void> {
  await db.update(pendingSignups).set({ consumedAt: new Date() }).where(eq(pendingSignups.id, id));
}

// Count signup attempts (consumed or not) since `since`, keyed by EITHER email
// OR ip — pass exactly one. Drives the per-window abuse throttle in the signup
// action so a single email/IP can't spray pending workspaces.
export async function countRecentSignups(opts: { email?: string; ip?: string | null; since: Date }): Promise<number> {
  const conds = [gte(pendingSignups.createdAt, opts.since)];
  if (opts.email) conds.push(eq(pendingSignups.adminEmail, opts.email));
  if (opts.ip) conds.push(eq(pendingSignups.ip, opts.ip));
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pendingSignups)
    .where(and(...conds));
  return row?.n ?? 0;
}
