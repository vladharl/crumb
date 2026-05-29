"use server";

import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { requireSession } from "@/lib/auth";

export async function revealSecret(): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "admin_only" };

  const [row] = await db
    .select({ secret: workspaces.signingSecret })
    .from(workspaces)
    .where(eq(workspaces.id, workspace.id))
    .limit(1);
  if (!row) return { ok: false, error: "workspace_not_found" };
  return { ok: true, secret: row.secret };
}

export async function rotateSecret(): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "admin_only" };

  const [row] = await db
    .update(workspaces)
    .set({ signingSecret: sql`encode(gen_random_bytes(32), 'hex')` })
    .where(eq(workspaces.id, workspace.id))
    .returning({ secret: workspaces.signingSecret });

  if (!row) return { ok: false, error: "rotate_failed" };
  return { ok: true, secret: row.secret };
}
