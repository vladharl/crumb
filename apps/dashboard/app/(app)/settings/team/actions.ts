"use server";

import { headers } from "next/headers";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, magicTokens, workspaceUsers } from "@crumb/db";
import { requireSession } from "@/lib/auth";
import { sendMagicLink } from "@/lib/email";
import { isCloud } from "@/lib/tier";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_TTL_DAYS = 7;
const VALID_ROLES = new Set(["admin", "pm", "viewer"]);

export type InviteResult =
  | { ok: true; link: string; email: string }
  | { ok: false; error: string };

function originFromHeaders(): string | null {
  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  if (!host) return null;
  return `${proto}://${host}`;
}

export async function inviteTeammate(formData: FormData): Promise<InviteResult> {
  const { workspace, user: me } = await requireSession();
  if (me.role !== "admin") return { ok: false, error: "Only admins can invite teammates." };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name  = String(formData.get("name") ?? "").trim();
  const role  = String(formData.get("role") ?? "pm");

  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email." };
  if (!name)                 return { ok: false, error: "Name is required." };
  if (!VALID_ROLES.has(role)) return { ok: false, error: "Pick a valid role." };

  const origin = originFromHeaders();
  if (!origin) return { ok: false, error: "Could not determine host." };

  // Avoid creating a duplicate user when the email already exists in the workspace.
  const [existing] = await db
    .select()
    .from(workspaceUsers)
    .where(and(eq(workspaceUsers.workspaceId, workspace.id), eq(workspaceUsers.email, email)))
    .limit(1);

  let invitee = existing;
  if (!invitee) {
    // Seat enforcement (Cloud only — self-host is unlimited). `seats` mirrors
    // the Stripe subscription quantity; a fresh invite that would push the
    // member count past it is blocked with a pointer to add seats. Re-inviting
    // an existing member (above) never trips this.
    if (isCloud()) {
      const members = await db
        .select({ id: workspaceUsers.id })
        .from(workspaceUsers)
        .where(eq(workspaceUsers.workspaceId, workspace.id));
      if (members.length >= workspace.seats) {
        return {
          ok: false,
          error: `Your plan includes ${workspace.seats} seat${workspace.seats === 1 ? "" : "s"}. Add seats in Billing to invite more teammates.`,
        };
      }
    }
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2)
      .map(s => s[0]?.toUpperCase() ?? "").join("") || "?";
    const inserted = await db.insert(workspaceUsers).values({
      workspaceId: workspace.id,
      email,
      name,
      role,
      initials: initials.slice(0, 4),
    }).returning();
    invitee = inserted[0]!;
  }

  // Clear any prior pending tokens for this user so the new link is the live one.
  await db
    .delete(magicTokens)
    .where(and(eq(magicTokens.workspaceUserId, invitee.id), isNull(magicTokens.consumedAt)));

  const token = randomBytes(24).toString("base64url");
  await db.insert(magicTokens).values({
    workspaceId: workspace.id,
    workspaceUserId: invitee.id,
    token,
    expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
  });

  const link = `${origin}/login/verify?token=${encodeURIComponent(token)}`;

  // Fire the email shim too — in dev that logs to stdout; in prod (later) it
  // dispatches via the configured provider. Either way, the admin can copy
  // the returned link directly.
  await sendMagicLink({ to: email, link, ttlMinutes: INVITE_TTL_DAYS * 24 * 60, workspaceName: workspace.name });

  return { ok: true, link, email };
}

export async function resendInvite(workspaceUserId: string): Promise<InviteResult> {
  const { workspace, user: me } = await requireSession();
  if (me.role !== "admin") return { ok: false, error: "Only admins can resend invites." };

  const [u] = await db
    .select()
    .from(workspaceUsers)
    .where(and(eq(workspaceUsers.workspaceId, workspace.id), eq(workspaceUsers.id, workspaceUserId)))
    .limit(1);
  if (!u) return { ok: false, error: "User not found." };

  const origin = originFromHeaders();
  if (!origin) return { ok: false, error: "Could not determine host." };

  await db
    .delete(magicTokens)
    .where(and(eq(magicTokens.workspaceUserId, u.id), isNull(magicTokens.consumedAt)));

  const token = randomBytes(24).toString("base64url");
  await db.insert(magicTokens).values({
    workspaceId: workspace.id,
    workspaceUserId: u.id,
    token,
    expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
  });

  const link = `${origin}/login/verify?token=${encodeURIComponent(token)}`;
  await sendMagicLink({ to: u.email, link, ttlMinutes: INVITE_TTL_DAYS * 24 * 60, workspaceName: workspace.name });

  return { ok: true, link, email: u.email };
}

export type MutationResult = { ok: true } | { ok: false; error: string };

export async function changeRole(workspaceUserId: string, role: string): Promise<MutationResult> {
  const { workspace, user: me } = await requireSession();
  if (me.role !== "admin") return { ok: false, error: "Only admins can change roles." };
  if (!VALID_ROLES.has(role)) return { ok: false, error: "Pick a valid role." };
  if (workspaceUserId === me.id) return { ok: false, error: "You can't change your own role." };

  const [target] = await db
    .select({ id: workspaceUsers.id, role: workspaceUsers.role })
    .from(workspaceUsers)
    .where(and(eq(workspaceUsers.workspaceId, workspace.id), eq(workspaceUsers.id, workspaceUserId)))
    .limit(1);
  if (!target) return { ok: false, error: "User not found." };

  // Don't allow demoting the last admin — at least one admin must remain.
  if (target.role === "admin" && role !== "admin") {
    const admins = await db
      .select({ id: workspaceUsers.id })
      .from(workspaceUsers)
      .where(and(eq(workspaceUsers.workspaceId, workspace.id), eq(workspaceUsers.role, "admin")));
    if (admins.length <= 1) return { ok: false, error: "Workspace must keep at least one admin." };
  }

  await db
    .update(workspaceUsers)
    .set({ role })
    .where(and(eq(workspaceUsers.workspaceId, workspace.id), eq(workspaceUsers.id, workspaceUserId)));

  return { ok: true };
}

export async function removeMember(workspaceUserId: string): Promise<MutationResult> {
  const { workspace, user: me } = await requireSession();
  if (me.role !== "admin") return { ok: false, error: "Only admins can remove teammates." };
  if (workspaceUserId === me.id) return { ok: false, error: "You can't remove yourself." };

  const [target] = await db
    .select({ id: workspaceUsers.id, role: workspaceUsers.role })
    .from(workspaceUsers)
    .where(and(eq(workspaceUsers.workspaceId, workspace.id), eq(workspaceUsers.id, workspaceUserId)))
    .limit(1);
  if (!target) return { ok: false, error: "User not found." };

  if (target.role === "admin") {
    const admins = await db
      .select({ id: workspaceUsers.id })
      .from(workspaceUsers)
      .where(and(eq(workspaceUsers.workspaceId, workspace.id), eq(workspaceUsers.role, "admin")));
    if (admins.length <= 1) return { ok: false, error: "Workspace must keep at least one admin." };
  }

  // Drop pending invites for this user — keep historical sessions/replies; items
  // remain assigned (the assignee column simply renders as orphaned initials).
  await db
    .delete(magicTokens)
    .where(and(eq(magicTokens.workspaceUserId, workspaceUserId)));

  await db
    .delete(workspaceUsers)
    .where(and(eq(workspaceUsers.workspaceId, workspace.id), eq(workspaceUsers.id, workspaceUserId)));

  return { ok: true };
}
