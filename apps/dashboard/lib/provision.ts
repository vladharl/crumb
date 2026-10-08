import "server-only";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, workspaceUsers, workspaces, type Workspace, type WorkspaceUser } from "@crumb/db";
import { isCloud } from "@/lib/tier";
import { seedSampleData } from "@/lib/samples";
import { log } from "@/lib/log";

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

// Slugs no workspace may take. The public pages live at /<slug>/roadmap and
// /<slug>/changelog, beside the app's own top-level routes, and a static route
// always wins over the [slug] segment, so a workspace with one of these slugs
// would get pages nobody can reach. Every top-level name in app/ and ee/app/
// (tests/unit/reserved-slugs keeps this in step), plus a few to grow into.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "accounts", "api", "ask", "captures", "changelog", "fonts", "inbox", "initiatives", "insights", "items",
  "login", "logout", "notifications", "onboard", "qbr", "roadmap", "settings", "signup", "t", "thread",
  "admin", "app", "auth", "billing", "dashboard", "docs", "help", "invite", "legal", "pricing", "privacy",
  "public", "status", "support", "terms", "widget",
]);

// Resolve `base` to an unused workspace slug, appending -2, -3, … on collision
// or when `base` is reserved. Used by self-serve signup (both when it starts
// and when the link is confirmed), which auto-derives the slug from the
// workspace name and must not error on a clash. There's still a TOCTOU window
// vs. the unique constraint — createWorkspaceWithAdmin's caller handles the
// rare insert failure by retrying.
export async function ensureUniqueSlug(base: string): Promise<string> {
  const root = (base || "workspace").slice(0, 60).replace(/-+$/, "") || "workspace";
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? root : `${root}-${n}`;
    if (RESERVED_SLUGS.has(candidate)) continue;
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

  // Cloud: seed a small sample set so the inbox, the tour and Insights aren't
  // empty on day one (lib/samples). Best-effort: a failed seed never blocks
  // signup. Self-host stays empty; operators run `pnpm db:seed` for demo data.
  if (isCloud()) {
    try {
      await seedSampleData(ws.id, user.id);
    } catch (err) {
      log.error("sample data seed failed", { scope: "crumb/provision", err });
    }
  }

  return { workspace: ws, user };
}
