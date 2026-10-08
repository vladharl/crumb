import "server-only";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db, pendingSignups, type PendingSignup } from "@crumb/db";

// Pending-signup queries the confirm step and "Resend the link" need on top of
// @crumb/db's create / find / consume / count helpers.
// ponytail: these belong in packages/db/src/pending-signups.ts; they live here
// only because this change stays inside the signup route's files.

// Burn a live token and return its row in one statement, so a double-clicked
// Create button (or the link open in two tabs) can't make two workspaces.
export async function claimPendingSignup(token: string): Promise<PendingSignup | null> {
  if (!token) return null;
  const now = new Date();
  const [row] = await db
    .update(pendingSignups)
    .set({ consumedAt: now })
    .where(and(
      eq(pendingSignups.token, token),
      isNull(pendingSignups.consumedAt),
      gt(pendingSignups.expiresAt, now),
    ))
    .returning();
  return row ?? null;
}

// Hand a claimed token back when provisioning failed, so the same link can retry.
export async function releasePendingSignup(id: string): Promise<void> {
  await db.update(pendingSignups).set({ consumedAt: null }).where(eq(pendingSignups.id, id));
}

// The newest unused signup for a link, or for an email + workspace name,
// expired or not: an expired one still prefills the form and can be resent.
export async function findOpenPendingSignup(
  by: { token: string } | { email: string; workspaceName: string },
): Promise<PendingSignup | null> {
  const match = "token" in by
    ? eq(pendingSignups.token, by.token)
    : and(eq(pendingSignups.adminEmail, by.email), eq(pendingSignups.workspaceName, by.workspaceName));
  const [row] = await db
    .select()
    .from(pendingSignups)
    .where(and(match, isNull(pendingSignups.consumedAt)))
    .orderBy(desc(pendingSignups.createdAt))
    .limit(1);
  return row ?? null;
}

// ?plan=&interval= from the marketing pricing CTAs, kept only when they name a
// real plan (lib/stripe's PaidPlan / BillingInterval). They ride along in the
// emailed link and on to /settings/billing?plan=&interval=, where the new
// workspace lands. Preselecting that plan there is the billing page's job.
export function billingParams(plan: unknown, interval: unknown): Record<string, string> {
  if (plan !== "team" && plan !== "growth") return {};
  return interval === "month" || interval === "year" ? { plan, interval } : { plan };
}
