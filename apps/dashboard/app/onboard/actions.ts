"use server";

import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db, workspaceUsers, workspaces } from "@crumb/db";
import { SESSION_COOKIE, createSession } from "@/lib/auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type OnboardResult = { ok: true } | { ok: false; error: string };

export async function bootstrapWorkspace(formData: FormData): Promise<OnboardResult> {
  // Re-check first-run on the server: never allow workspace creation once
  // any user exists — that protects against a stale browser tab being used
  // to clobber a fresh deploy.
  const [existing] = await db.select({ id: workspaceUsers.id }).from(workspaceUsers).limit(1);
  if (existing) return { ok: false, error: "Workspace already set up. Sign in instead." };

  const workspaceName = String(formData.get("workspaceName") ?? "").trim();
  const slugRaw       = String(formData.get("slug") ?? "").trim().toLowerCase();
  const adminName     = String(formData.get("adminName") ?? "").trim();
  const adminEmail    = String(formData.get("adminEmail") ?? "").trim().toLowerCase();

  if (!workspaceName)            return { ok: false, error: "Workspace name is required." };
  if (!SLUG_RE.test(slugRaw))    return { ok: false, error: "Slug must be lowercase letters, numbers, or hyphens (2–64 chars)." };
  if (!adminName)                return { ok: false, error: "Your name is required." };
  if (!EMAIL_RE.test(adminEmail)) return { ok: false, error: "Enter a valid email." };

  const [slugTaken] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slugRaw)).limit(1);
  if (slugTaken) return { ok: false, error: "That workspace slug is already taken." };

  const initials = adminName.split(/\s+/).filter(Boolean).slice(0, 2)
    .map(s => s[0]?.toUpperCase() ?? "").join("") || "?";

  const [ws] = await db.insert(workspaces).values({
    slug: slugRaw,
    name: workspaceName,
  }).returning();
  if (!ws) return { ok: false, error: "Could not create workspace." };

  const [user] = await db.insert(workspaceUsers).values({
    workspaceId: ws.id,
    email: adminEmail,
    name: adminName,
    role: "admin",
    initials: initials.slice(0, 4),
  }).returning();
  if (!user) return { ok: false, error: "Could not create admin user." };

  const { cookieValue, expiresAt } = await createSession(ws.id, user.id);
  cookies().set(SESSION_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });

  // Don't redirect server-side; let the client navigate so the Set-Cookie on
  // this action's response has actually settled in the browser before
  // /inbox's requireSession() runs.
  return { ok: true };
}
