"use server";

import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db, workspaces, findValidSetupToken, consumeSetupToken } from "@crumb/db";
import { SESSION_COOKIE, createSession } from "@/lib/auth";
import { createWorkspaceWithAdmin } from "@/lib/provision";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type OnboardResult = { ok: true } | { ok: false; error: string };

export async function bootstrapWorkspace(formData: FormData): Promise<OnboardResult> {
  // Onboarding is authorized only by a valid one-time setup link (minted on the
  // host via `cli setup-link`). The token — not an empty-instance check — is the
  // gate, so this works for the first use of any NEW workspace, not just the
  // first workspace on the instance.
  const setup = await findValidSetupToken(String(formData.get("token") ?? ""));
  if (!setup) return { ok: false, error: "This setup link is invalid or expired. Generate a new one on the server." };

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

  const created = await createWorkspaceWithAdmin({
    name: workspaceName,
    slug: slugRaw,
    adminName,
    adminEmail,
  });
  if (!created) return { ok: false, error: "Could not create workspace." };
  const { workspace: ws, user } = created;

  const { cookieValue, expiresAt } = await createSession(ws.id, user.id);
  cookies().set(SESSION_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });

  // Burn the setup link now that the workspace exists — it's single-use.
  await consumeSetupToken(setup.id);

  // Don't redirect server-side; let the client navigate so the Set-Cookie on
  // this action's response has actually settled in the browser before
  // /inbox's requireSession() runs.
  return { ok: true };
}
