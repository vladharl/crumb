import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "./client";
import { setupTokens, workspaces } from "./schema";

// Default validity for a freshly minted setup link.
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 60 minutes

// Mint a one-time setup token that gates the /onboard screen. Returns the raw
// token (store nothing else; the row tracks expiry + consumption).
export async function createSetupToken(ttlMs: number = DEFAULT_TTL_MS): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await db.insert(setupTokens).values({
    token,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return token;
}

// First run = no workspace yet. Mint a token only then (null otherwise), so the
// container start hook never prints a fresh way in on a live instance.
export async function createFirstRunSetupToken(ttlMs: number): Promise<string | null> {
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
  return ws ? null : createSetupToken(ttlMs);
}

// The /onboard link for a token: absolute from CRUMB_APP_URL, or just the path
// when that's unset (the operator opens it on their dashboard's address).
export function setupLinkFor(token: string, appUrl: string = process.env.CRUMB_APP_URL ?? ""): string {
  return `${appUrl.trim().replace(/\/+$/, "")}/onboard?token=${encodeURIComponent(token)}`;
}

// Resolve a token to its row id iff it exists, is unconsumed, and unexpired.
export async function findValidSetupToken(token: string): Promise<{ id: string } | null> {
  if (!token) return null;
  const [row] = await db
    .select({ id: setupTokens.id })
    .from(setupTokens)
    .where(and(
      eq(setupTokens.token, token),
      isNull(setupTokens.consumedAt),
      gt(setupTokens.expiresAt, new Date()),
    ))
    .limit(1);
  return row ?? null;
}

// Claim a token for its single use. Atomic: the guarded UPDATE lets only one of
// two racing submissions win, so one link can never create two workspaces.
export async function claimSetupToken(id: string): Promise<boolean> {
  const rows = await db
    .update(setupTokens)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(setupTokens.id, id),
      isNull(setupTokens.consumedAt),
      gt(setupTokens.expiresAt, new Date()),
    ))
    .returning({ id: setupTokens.id });
  return rows.length > 0;
}

// Give a claimed token back when the workspace couldn't be created, so the
// operator can retry with the same link.
export async function releaseSetupToken(id: string): Promise<void> {
  await db.update(setupTokens).set({ consumedAt: null }).where(eq(setupTokens.id, id));
}
