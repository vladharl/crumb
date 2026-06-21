import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import {
  db, magicTokens, sessions, workspaces, workspaceUsers,
  type Workspace, type WorkspaceUser,
} from "@crumb/db";
import { sendMagicLink } from "./email";

export const SESSION_COOKIE = "crumb_session";
const SESSION_TTL_DAYS = 7;
const TOKEN_TTL_MIN = 20;

export type Session = {
  workspace: Workspace;
  user: WorkspaceUser;
};

function hashCookie(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// ─── session reads ─────────────────────────────────────────
// Memoized per request: the (app) layout and every page that calls
// getActiveSession()/requireSession() would otherwise each run this 3-table
// session join. cache() collapses them to one query per render pass (the
// cookie can't change mid-request), saving a DB round trip on every
// authenticated render — including each thread open.
export const getSession = cache(async function getSession(): Promise<Session | null> {
  const cookie = cookies().get(SESSION_COOKIE)?.value;
  if (!cookie) return null;
  const tokenHash = hashCookie(cookie);

  const [row] = await db
    .select({
      workspace: workspaces,
      user: workspaceUsers,
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(workspaces,     eq(workspaces.id,     sessions.workspaceId))
    .innerJoin(workspaceUsers, eq(workspaceUsers.id, sessions.workspaceUserId))
    .where(and(
      eq(sessions.tokenHash, tokenHash),
      gt(sessions.expiresAt, new Date()),
    ))
    .limit(1);

  if (!row) return null;
  return { workspace: row.workspace, user: row.user };
});

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

// ─── magic link issue + consume ────────────────────────────
export async function issueMagicLink(email: string, origin: string): Promise<{ delivered: boolean }> {
  const [user] = await db
    .select()
    .from(workspaceUsers)
    .where(eq(workspaceUsers.email, email.trim().toLowerCase()))
    .limit(1);

  // No-account-found: still return "delivered" so we don't leak existence.
  if (!user) return { delivered: true };

  const [ws] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, user.workspaceId))
    .limit(1);

  // Clean up any pending tokens for this user before issuing a fresh one.
  await db
    .delete(magicTokens)
    .where(and(
      eq(magicTokens.workspaceUserId, user.id),
      isNull(magicTokens.consumedAt),
    ));

  const token = randomToken(24);
  await db.insert(magicTokens).values({
    workspaceId: user.workspaceId,
    workspaceUserId: user.id,
    token,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MIN * 60 * 1000),
  });

  const link = `${origin}/login/verify?token=${encodeURIComponent(token)}`;
  await sendMagicLink({
    to: user.email,
    link,
    ttlMinutes: TOKEN_TTL_MIN,
    workspaceName: ws?.name,
  });

  return { delivered: true };
}

export type ConsumeResult =
  | { ok: true; cookieValue: string; expiresAt: Date }
  | { ok: false; error: "not_found" | "expired" | "consumed" };

export async function consumeMagicToken(token: string): Promise<ConsumeResult> {
  if (!token) return { ok: false, error: "not_found" };

  const [row] = await db
    .select()
    .from(magicTokens)
    .where(eq(magicTokens.token, token))
    .limit(1);

  if (!row) return { ok: false, error: "not_found" };
  if (row.consumedAt) return { ok: false, error: "consumed" };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, error: "expired" };

  // Mark consumed first; if anything below fails we'd rather fail-closed than
  // leave a re-usable token in the wild.
  await db
    .update(magicTokens)
    .set({ consumedAt: new Date() })
    .where(eq(magicTokens.id, row.id));

  const cookieValue = randomToken(32);
  const tokenHash = hashCookie(cookieValue);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({
    workspaceId: row.workspaceId,
    workspaceUserId: row.workspaceUserId,
    tokenHash,
    expiresAt,
  });

  return { ok: true, cookieValue, expiresAt };
}

// Create a session for a specific user — used by onboarding & invite-accept
// where we don't go through the magic-link verify endpoint.
export async function createSession(
  workspaceId: string,
  workspaceUserId: string,
): Promise<{ cookieValue: string; expiresAt: Date }> {
  const cookieValue = randomToken(32);
  const tokenHash = hashCookie(cookieValue);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({
    workspaceId,
    workspaceUserId,
    tokenHash,
    expiresAt,
  });
  return { cookieValue, expiresAt };
}

export async function destroySession(): Promise<void> {
  const cookie = cookies().get(SESSION_COOKIE)?.value;
  if (cookie) {
    await db.delete(sessions).where(eq(sessions.tokenHash, hashCookie(cookie)));
  }
}

// Best-effort cleanup hook callers can fire-and-forget.
export async function pruneExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
