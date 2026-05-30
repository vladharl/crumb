import { createCipheriv, randomBytes } from "node:crypto";
import { isNotNull, or, eq } from "drizzle-orm";
import { db, workspaces } from "./index";

// One-off backfill: encrypt integration secrets that were stored as plaintext
// before envelope encryption landed (see apps/dashboard/lib/crypto-at-rest.ts).
//
//   pnpm --filter @crumb/db exec tsx src/backfill-encrypt-secrets.ts
//
// Idempotent: rows already in the `enc:` format are skipped, so it's safe to
// run more than once (and after each new key rotation). Requires the SAME
// CRUMB_ENCRYPTION_KEY / CRUMB_ENCRYPTION_KEY_ID the app uses, or the app
// won't be able to open() what this seals.
//
// The seal() logic is intentionally duplicated here (a tiny slice of node
// crypto) rather than imported from the Next app — keeping @crumb/db free of
// any dependency on apps/dashboard. The stored format MUST stay in lockstep
// with crypto-at-rest.ts.

const PREFIX = "enc";
const VERSION = "1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

function loadKey(): { id: string; key: Buffer } {
  const raw = process.env.CRUMB_ENCRYPTION_KEY?.trim();
  if (!raw) {
    console.error("CRUMB_ENCRYPTION_KEY is required to run the backfill.");
    process.exit(1);
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    console.error("CRUMB_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64).");
    process.exit(1);
  }
  return { id: process.env.CRUMB_ENCRYPTION_KEY_ID?.trim() || "1", key };
}

function seal(plaintext: string, id: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, VERSION, id, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

const COLUMNS = ["slackBotToken", "linearAccessToken", "jiraAccessToken", "jiraRefreshToken"] as const;

async function main() {
  const { id, key } = loadKey();

  const rows = await db
    .select({
      id: workspaces.id,
      slackBotToken: workspaces.slackBotToken,
      linearAccessToken: workspaces.linearAccessToken,
      jiraAccessToken: workspaces.jiraAccessToken,
      jiraRefreshToken: workspaces.jiraRefreshToken,
    })
    .from(workspaces)
    .where(
      or(
        isNotNull(workspaces.slackBotToken),
        isNotNull(workspaces.linearAccessToken),
        isNotNull(workspaces.jiraAccessToken),
        isNotNull(workspaces.jiraRefreshToken),
      ),
    );

  let sealed = 0;
  let skipped = 0;
  for (const row of rows) {
    const update: Partial<Record<(typeof COLUMNS)[number], string>> = {};
    for (const col of COLUMNS) {
      const value = row[col];
      if (value == null) continue;
      if (value.startsWith(`${PREFIX}:`)) {
        skipped++;
        continue;
      }
      update[col] = seal(value, id, key);
      sealed++;
    }
    if (Object.keys(update).length > 0) {
      await db.update(workspaces).set(update).where(eq(workspaces.id, row.id));
    }
  }

  console.log(`[backfill] sealed ${sealed} secret(s), skipped ${skipped} already-encrypted across ${rows.length} workspace(s).`);
  process.exit(0);
}

main().catch(err => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});
