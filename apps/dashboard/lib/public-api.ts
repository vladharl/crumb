import "server-only";
import { NextResponse } from "next/server";
import { db, workspaces, accounts, accountUsers } from "@crumb/db";
import { and, eq, sql } from "drizzle-orm";
import { verify } from "./jwt";
import { isCloud } from "./tier";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export function cors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function fail(status: number, error: string): NextResponse {
  return cors(NextResponse.json({ error }, { status }));
}

export type CustomerCtx = {
  workspace: typeof workspaces.$inferSelect;
  user: typeof accountUsers.$inferSelect;
  /** How the identity was established. "jwt" is the secure path. */
  auth: "jwt" | "trusted_email";
};

/**
 * Resolve a customer-side actor from a Request.
 *
 * Preferred path: `Authorization: Bearer <jwt>` — verified against the
 * workspace's signing secret. The workspace is identified by `iss`, the
 * user by `sub` (email), and the account by `account_name`. Account +
 * user rows are upserted on first contact.
 *
 * Fallback (legacy / dev demo): explicit `workspaceSlug` + `email`. Trusted
 * blindly — fine for the bundled `widget-demo.html` and the OSS getting-
 * started path on **self-host**.
 *
 * On **Cloud** (`CRUMB_TIER=cloud`), the trusted-email fallback is hard
 * rejected with 401 `jwt_required` — production deployments must sign
 * a JWT with the workspace's signing secret. The single chokepoint here
 * means every public-API caller funnels through the same gate.
 */
export async function resolveCustomer(
  req: Request,
  fallback: { workspaceSlug: string | null; email: string | null; accountName?: string | null; userName?: string | null } = { workspaceSlug: null, email: null },
): Promise<{ ok: true; ctx: CustomerCtx } | { ok: false; status: number; error: string }> {
  // ── JWT path ─────────────────────────────────────────────
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    return resolveFromJwt(token);
  }

  // ── trusted-email fallback (self-host only) ─────────────
  if (isCloud()) {
    return { ok: false, status: 401, error: "jwt_required" };
  }
  const { workspaceSlug, email, accountName, userName } = fallback;
  if (!workspaceSlug) return { ok: false, status: 400, error: "missing_workspace_slug" };
  if (!email)         return { ok: false, status: 400, error: "missing_email" };

  const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, workspaceSlug)).limit(1);
  if (!ws) return { ok: false, status: 404, error: "workspace_not_found" };

  const [user] = await db
    .select()
    .from(accountUsers)
    .where(and(eq(accountUsers.workspaceId, ws.id), eq(accountUsers.email, email)))
    .limit(1);

  if (user) return { ok: true, ctx: { workspace: ws, user, auth: "trusted_email" } };

  // Upsert the user (and account) when we have enough info — keeps the
  // legacy widget flow working without two round-trips.
  if (!accountName) return { ok: false, status: 404, error: "user_not_found" };
  const ctx = await upsertAccountAndUser(ws.id, email, userName ?? null, accountName);
  return { ok: true, ctx: { workspace: ws, user: ctx.user, auth: "trusted_email" } };
}

async function resolveFromJwt(token: string): Promise<{ ok: true; ctx: CustomerCtx } | { ok: false; status: number; error: string }> {
  // We don't know which workspace yet; peek at the unverified iss claim, look
  // up the secret, then verify.
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return { ok: false, status: 401, error: "invalid_token" };

  let issuer: string | null = null;
  try {
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    issuer = JSON.parse(json)?.iss ?? null;
  } catch {
    return { ok: false, status: 401, error: "invalid_token" };
  }
  if (!issuer) return { ok: false, status: 401, error: "invalid_token" };

  const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, issuer)).limit(1);
  if (!ws) return { ok: false, status: 404, error: "workspace_not_found" };

  const result = verify(token, ws.signingSecret);
  if (!result.ok) {
    const status = result.reason === "expired" ? 401 : 401;
    return { ok: false, status, error: `jwt_${result.reason}` };
  }

  const { sub: email, name, account_name, role } = result.claims;
  const ctx = await upsertAccountAndUser(ws.id, email, name ?? null, account_name, role ?? null);
  return { ok: true, ctx: { workspace: ws, user: ctx.user, auth: "jwt" } };
}

async function upsertAccountAndUser(
  workspaceId: string,
  email: string,
  name: string | null,
  accountName: string,
  // Host-designated role from a verified JWT claim, if any. When present the
  // host product is the source of truth and we (re)apply it on every load.
  roleClaim?: "admin" | "member" | null,
): Promise<{ user: typeof accountUsers.$inferSelect; account: typeof accounts.$inferSelect }> {
  const accountWhere = and(eq(accounts.workspaceId, workspaceId), eq(accounts.name, accountName));
  const userWhere = and(eq(accountUsers.workspaceId, workspaceId), eq(accountUsers.email, email));
  let [account] = await db.select().from(accounts).where(accountWhere).limit(1);
  let [user] = await db.select().from(accountUsers).where(userWhere).limit(1);

  if (!account || !user) {
    // First contact. The widget boots /me and /items at once, so two requests
    // can get here together. accounts has no unique (workspace, name) index
    // to upsert on, so creating takes a per-account lock: concurrent first
    // loads make one account, and its first user is still its admin.
    ({ account, user } = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${accountName}`}, 0))`);
      let [a] = await tx.select().from(accounts).where(accountWhere).limit(1);
      const accountCreated = !a;
      if (!a) [a] = await tx.insert(accounts).values({ workspaceId, name: accountName }).returning();
      let [u] = await tx.select().from(accountUsers).where(userWhere).limit(1);
      if (!u) {
        const initialsSource = name ?? email;
        const initials = initialsSource
          .split(/\s+|@/).filter(Boolean).slice(0, 2)
          .map(s => s[0]?.toUpperCase() ?? "").join("") || "?";
        // First admin bootstrap: the very first user of a brand-new account becomes
        // its admin (otherwise no account would ever have one, since the JWT/email
        // flow defaults everyone to "member"). An explicit JWT role claim wins.
        const role = roleClaim ?? (accountCreated ? "admin" : "member");
        // The same person arriving under another account name at the same time
        // isn't serialized by that lock; the (workspace, email) unique index
        // decides, and the loser reads the winner's row.
        [u] = await tx.insert(accountUsers).values({
          workspaceId,
          accountId: a!.id,
          email,
          name: name ?? email.split("@")[0]!,
          initials: initials.slice(0, 4),
          role,
        }).onConflictDoNothing().returning();
        if (!u) [u] = await tx.select().from(accountUsers).where(userWhere).limit(1);
      }
      return { account: a!, user: u! };
    }));
  }

  if (roleClaim && user.role !== roleClaim) {
    // Existing user + host asserts a role → host wins; re-apply so a
    // widget-side change can't drift from the host's source of truth.
    const [updated] = await db
      .update(accountUsers)
      .set({ role: roleClaim })
      .where(eq(accountUsers.id, user.id))
      .returning();
    if (updated) user = updated;
  }

  return { user, account };
}
