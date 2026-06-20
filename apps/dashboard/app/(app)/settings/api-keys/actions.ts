"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, apiKeys } from "@crumb/db";
import { requireSession } from "@/lib/auth";
import { newApiKey } from "@/lib/api-keys";

const MAX_KEYS = 20;

export type CreateResult =
  | { ok: true; id: string; name: string; raw: string; prefix: string }
  | { ok: false; error: string };

export async function createApiKey(formData: FormData): Promise<CreateResult> {
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "Only admins can manage API keys." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Give the key a name." };
  if (name.length > 80) return { ok: false, error: "Name is too long (80 chars max)." };

  const active = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, workspace.id), isNull(apiKeys.revokedAt)));
  if (active.length >= MAX_KEYS) return { ok: false, error: `Limit of ${MAX_KEYS} active keys reached.` };

  const k = newApiKey();
  const [created] = await db
    .insert(apiKeys)
    .values({
      workspaceId: workspace.id,
      createdByWorkspaceUserId: user.id,
      name,
      tokenHash: k.hash,
      prefix: k.prefix,
    })
    .returning({ id: apiKeys.id });

  revalidatePath("/settings/api-keys");
  // Return the raw key once — it's never recoverable after this.
  return { ok: true, id: created!.id, name, raw: k.raw, prefix: k.prefix };
}

export type MutationResult = { ok: true } | { ok: false; error: string };

export async function revokeApiKey(id: string): Promise<MutationResult> {
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "Only admins can manage API keys." };
  const r = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspace.id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  if (r.length === 0) return { ok: false, error: "Key not found." };
  revalidatePath("/settings/api-keys");
  return { ok: true };
}
