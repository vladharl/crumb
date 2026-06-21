import "server-only";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, workspaceUsers, workspaces, type Workspace, type WorkspaceUser } from "@crumb/db";

// Shared workspace-provisioning core. Both the operator onboarding flow
// (/onboard) and self-serve signup (/signup) create a workspace + its first
// admin the same way; keeping it here means the two paths can't drift.

export type ProvisionInput = {
  name: string;
  slug: string;
  adminName: string;
  adminEmail: string;
};

// Two-letter initials from a display name (e.g. "Jane Doe" → "JD"). Mirrors the
// derivation onboarding used inline before this was extracted.
export function initialsFrom(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map(s => s[0]?.toUpperCase() ?? "").join("") || "?";
}

// Resolve `base` to an unused workspace slug, appending -2, -3, … on collision.
// Used by self-serve signup, which auto-derives the slug from the workspace
// name and must not error on a clash. There's still a TOCTOU window vs. the
// unique constraint — createWorkspaceWithAdmin's caller handles the rare insert
// failure by retrying.
export async function ensureUniqueSlug(base: string): Promise<string> {
  const root = (base || "workspace").slice(0, 60);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? root : `${root}-${n}`;
    const [taken] = await db.select({ id: workspaces.id })
      .from(workspaces).where(eq(workspaces.slug, candidate)).limit(1);
    if (!taken) return candidate;
  }
  // Effectively unreachable; fall back to a random suffix rather than loop forever.
  return `${root.slice(0, 53)}-${randomBytes(3).toString("hex")}`;
}

// Create a workspace and its first admin user. The new workspace defaults to
// the free plan (schema default); upgrading happens later via Billing. Caller
// owns slug uniqueness and session creation. Returns null if either insert
// produced no row (e.g. a slug unique-constraint violation surfaces as a throw,
// which the caller catches).
export async function createWorkspaceWithAdmin(
  input: ProvisionInput,
): Promise<{ workspace: Workspace; user: WorkspaceUser } | null> {
  const [ws] = await db.insert(workspaces).values({
    slug: input.slug,
    name: input.name,
  }).returning();
  if (!ws) return null;

  const [user] = await db.insert(workspaceUsers).values({
    workspaceId: ws.id,
    email: input.adminEmail,
    name: input.adminName,
    role: "admin",
    initials: initialsFrom(input.adminName).slice(0, 4),
  }).returning();
  if (!user) return null;

  return { workspace: ws, user };
}
