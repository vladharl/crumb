"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, inboundCaptures } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { composeItem } from "@/lib/compose";

function canManage(role: string): boolean {
  return role === "admin" || role === "pm";
}

export type CaptureActionResult = { ok: true; shortId?: string } | { ok: false; error: string };

// Confirm a pending capture's account mapping and create the real item via the
// shared composeItem (upserts account+submitter, satisfies the NOT-NULL FK),
// then mark the capture accepted.
export async function createItemFromCapture(input: {
  captureId: string;
  accountName: string;
  submitterEmail: string;
  submitterName?: string;
  type: string;
  title: string;
  body?: string;
}): Promise<CaptureActionResult> {
  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  const [cap] = await db
    .select({ id: inboundCaptures.id, status: inboundCaptures.status, source: inboundCaptures.source, rawMeta: inboundCaptures.rawMeta })
    .from(inboundCaptures)
    .where(and(eq(inboundCaptures.workspaceId, workspace.id), eq(inboundCaptures.id, input.captureId)))
    .limit(1);
  if (!cap) return { ok: false, error: "not_found" };
  if (cap.status !== "pending") return { ok: false, error: "already_decided" };

  // Carry the capture's origin onto the item so provenance (and the
  // widget-only auto-notify rule, lib/feedback/source) survive acceptance —
  // accepting a Zendesk/Gong capture must not turn it into a notifiable item.
  let sourceUrl: string | null = null;
  try {
    sourceUrl = cap.rawMeta ? ((JSON.parse(cap.rawMeta) as { url?: string | null }).url ?? null) : null;
  } catch {
    sourceUrl = null;
  }

  const r = await composeItem({
    workspaceId: workspace.id,
    workspace,
    actorWorkspaceUserId: user.id,
    accountName: input.accountName,
    submitterEmail: input.submitterEmail,
    submitterName: input.submitterName,
    type: input.type,
    title: input.title,
    body: input.body,
    source: cap.source,
    sourceUrl,
  });
  if (!r.ok) return { ok: false, error: r.error };

  await db
    .update(inboundCaptures)
    .set({ status: "accepted", createdItemId: r.itemId, decidedAt: new Date(), decidedByWorkspaceUserId: user.id })
    .where(eq(inboundCaptures.id, cap.id));

  revalidatePath("/captures");
  revalidatePath("/inbox");
  return { ok: true, shortId: r.shortId };
}

export async function dismissCapture(captureId: string): Promise<CaptureActionResult> {
  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  await db
    .update(inboundCaptures)
    .set({ status: "dismissed", decidedAt: new Date(), decidedByWorkspaceUserId: user.id })
    .where(and(eq(inboundCaptures.workspaceId, workspace.id), eq(inboundCaptures.id, captureId)));

  revalidatePath("/inbox");
  return { ok: true };
}

// Undo a dismiss: dismissal is a soft status flip, so restoring is just moving
// it back to "pending" (only if it's still dismissed — never resurrect a
// capture that was meanwhile accepted into a real item).
export async function restoreCapture(captureId: string): Promise<CaptureActionResult> {
  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  const [cap] = await db
    .select({ status: inboundCaptures.status })
    .from(inboundCaptures)
    .where(and(eq(inboundCaptures.workspaceId, workspace.id), eq(inboundCaptures.id, captureId)))
    .limit(1);
  if (!cap) return { ok: false, error: "not_found" };
  if (cap.status !== "dismissed") return { ok: false, error: "already_decided" };

  await db
    .update(inboundCaptures)
    .set({ status: "pending", decidedAt: null, decidedByWorkspaceUserId: null })
    .where(and(eq(inboundCaptures.workspaceId, workspace.id), eq(inboundCaptures.id, captureId)));

  revalidatePath("/inbox");
  return { ok: true };
}
