"use server";

import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { requireSession } from "@/lib/auth";
import { sign } from "@/lib/jwt";
import { TEST_CUSTOMER_ACCOUNT } from "./test-customer";

const TEST_TOKEN_TTL_SEC = 15 * 60;

// "Try it": a short-lived widget identity token for the signed-in teammate,
// playing a clearly named test customer. Signed with the workspace secret
// exactly as a vendor's server would (lib/jwt.ts verifies it).
export async function mintTestToken(): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const { workspace, user } = await requireSession();
  if (user.role !== "admin" && user.role !== "pm") return { ok: false, error: "forbidden" };

  const now = Math.floor(Date.now() / 1000);
  const token = sign({
    iss: workspace.slug,
    // Never the teammate's own email: customers are matched by email alone, so
    // their real-widget test (or a real customer with that address) would land
    // in the test account. A reserved .invalid address is never emailed either.
    sub: `preview+${user.id}@${workspace.slug}.invalid`,
    name: user.name,
    account_name: TEST_CUSTOMER_ACCOUNT,
    iat: now,
    exp: now + TEST_TOKEN_TTL_SEC,
  }, workspace.signingSecret);
  return { ok: true, token };
}

// Polled by the Install page until the widget's first real ping lands.
export async function widgetFirstPingAt(): Promise<string | null> {
  const { workspace } = await requireSession();
  return workspace.widgetFirstPingAt?.toISOString() ?? null;
}

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
