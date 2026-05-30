"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, webhookEndpoints } from "@crumb/db";
import { requireSession } from "@/lib/auth";
import { newWebhookSecret, isDeliverableUrl } from "@/lib/webhooks";

const MAX_ENDPOINTS = 10;

export type CreateResult =
  | { ok: true; id: string; url: string; secret: string }
  | { ok: false; error: string };

function validUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function createWebhook(formData: FormData): Promise<CreateResult> {
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "Only admins can manage webhooks." };

  const url = validUrl(String(formData.get("url") ?? ""));
  if (!url) return { ok: false, error: "Enter a valid http(s) URL." };
  // Block delivery to private/internal hosts (Cloud); gives immediate feedback
  // rather than silently auto-pausing on the first delivery.
  if (!(await isDeliverableUrl(url))) {
    return { ok: false, error: "That URL must be publicly reachable and not resolve to a private/internal address." };
  }

  const existing = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.workspaceId, workspace.id));
  if (existing.length >= MAX_ENDPOINTS) return { ok: false, error: `Limit of ${MAX_ENDPOINTS} endpoints reached.` };

  const secret = newWebhookSecret();
  const [created] = await db
    .insert(webhookEndpoints)
    .values({ workspaceId: workspace.id, url, secret })
    .returning({ id: webhookEndpoints.id, url: webhookEndpoints.url });

  revalidatePath("/settings/webhooks");
  // Return the secret once — the vendor stores it on their receiver to verify
  // signatures. It's also re-revealable from the list (admin only).
  return { ok: true, id: created!.id, url: created!.url, secret };
}

export type MutationResult = { ok: true } | { ok: false; error: string };

export async function setWebhookActive(id: string, active: boolean): Promise<MutationResult> {
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "Only admins can manage webhooks." };
  const r = await db
    .update(webhookEndpoints)
    // Re-enabling resets the failure counter so a recovered endpoint isn't
    // instantly re-paused by stale failures.
    .set(active ? { active: true, failureCount: 0 } : { active: false })
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspaceId, workspace.id)))
    .returning({ id: webhookEndpoints.id });
  if (r.length === 0) return { ok: false, error: "Endpoint not found." };
  revalidatePath("/settings/webhooks");
  return { ok: true };
}

export async function deleteWebhook(id: string): Promise<MutationResult> {
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "Only admins can manage webhooks." };
  await db
    .delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspaceId, workspace.id)));
  revalidatePath("/settings/webhooks");
  return { ok: true };
}

export async function revealWebhookSecret(id: string): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "Only admins can view secrets." };
  const [row] = await db
    .select({ secret: webhookEndpoints.secret })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspaceId, workspace.id)))
    .limit(1);
  if (!row) return { ok: false, error: "Endpoint not found." };
  return { ok: true, secret: row.secret };
}
