import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "./client";
import { setupTokens } from "./schema";

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

// Burn a token so its link can't be reused.
export async function consumeSetupToken(id: string): Promise<void> {
  await db.update(setupTokens).set({ consumedAt: new Date() }).where(eq(setupTokens.id, id));
}
