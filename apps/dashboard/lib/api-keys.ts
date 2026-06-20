import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, apiKeys, workspaces, workspaceUsers } from "@crumb/db";
import type { VendorRole } from "@/lib/items/mutations";

// Workspace-scoped bearer tokens for the MCP server (and any future API
// surface). A vendor mints a key from settings; we show the raw value once and
// store only its sha256 hash — the same one-way scheme as session cookies
// (lib/auth.ts). Resolution hashes the incoming bearer and looks the row up.
//
// Every key is tied to its creator: a write performed with the key is
// attributed to that workspace user (with their LIVE role, re-read here, so a
// demotion immediately narrows the key's power).

// Visible, recognizable, and obviously-a-secret. The `sk` echoes the common
// "secret key" convention so a leaked value is easy to spot in logs.
const KEY_PREFIX = "crumb_sk_";
const PREFIX_DISPLAY_LEN = 16; // chars of the raw key kept for the settings list

export type NewApiKey = { raw: string; hash: string; prefix: string };

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Mint a fresh key. The raw value is returned ONCE to show the vendor; only
// `hash` + `prefix` are persisted.
export function newApiKey(): NewApiKey {
  const raw = KEY_PREFIX + randomBytes(24).toString("base64url");
  return { raw, hash: hashKey(raw), prefix: raw.slice(0, PREFIX_DISPLAY_LEN) };
}

export type ResolvedApiKey = {
  apiKeyId: string;
  workspaceId: string;
  workspaceSlug: string;
  actorWorkspaceUserId: string;
  role: VendorRole;
};

// Resolve a raw bearer token to its workspace + actor, or null if it's not a
// Crumb key, is unknown, or has been revoked. Bumps last_used_at best-effort.
// The actor's role is read live from workspace_users (not frozen at key
// creation) so revoking a teammate's manage rights narrows their keys too.
export async function resolveApiKey(raw: string | null | undefined): Promise<ResolvedApiKey | null> {
  const token = raw?.trim();
  if (!token || !token.startsWith(KEY_PREFIX)) return null;

  const [row] = await db
    .select({
      apiKeyId: apiKeys.id,
      workspaceId: apiKeys.workspaceId,
      workspaceSlug: workspaces.slug,
      actorWorkspaceUserId: workspaceUsers.id,
      role: workspaceUsers.role,
    })
    .from(apiKeys)
    .innerJoin(workspaces, eq(workspaces.id, apiKeys.workspaceId))
    .innerJoin(workspaceUsers, eq(workspaceUsers.id, apiKeys.createdByWorkspaceUserId))
    .where(and(eq(apiKeys.tokenHash, hashKey(token)), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;

  // Best-effort recency stamp — never block resolution on it.
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.apiKeyId))
    .catch(() => {});

  const role: VendorRole = row.role === "admin" || row.role === "viewer" ? row.role : "pm";
  return {
    apiKeyId: row.apiKeyId,
    workspaceId: row.workspaceId,
    workspaceSlug: row.workspaceSlug,
    actorWorkspaceUserId: row.actorWorkspaceUserId,
    role,
  };
}

// Extract a bearer token from an Authorization header. Returns null when
// absent or malformed.
export function bearerFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}
