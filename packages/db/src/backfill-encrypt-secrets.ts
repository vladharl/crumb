import { createCipheriv, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, accounts, integrationConnections, workspaces } from "./index";
import { envOrFile } from "./client";

// One-off backfill: encrypt integration secrets that were stored as plaintext
// before envelope encryption landed (see apps/dashboard/lib/crypto-at-rest.ts).
//
//   pnpm --filter @crumb/db exec tsx src/backfill-encrypt-secrets.ts
//
// Idempotent: rows already in the `enc:` format are skipped, so it's safe to
// run more than once (and after each new key rotation). Requires the SAME
// CRUMB_ENCRYPTION_KEY / CRUMB_ENCRYPTION_KEY_ID the app uses, or the app
// won't be able to open() what this seals. Like the server, it also reads them
// from CRUMB_ENCRYPTION_KEY_FILE / CRUMB_ENCRYPTION_KEY_ID_FILE.
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
  const raw = envOrFile("CRUMB_ENCRYPTION_KEY")?.trim();
  if (!raw) {
    console.error("CRUMB_ENCRYPTION_KEY (or CRUMB_ENCRYPTION_KEY_FILE) is required to run the backfill.");
    process.exit(1);
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    console.error("CRUMB_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64).");
    process.exit(1);
  }
  return { id: envOrFile("CRUMB_ENCRYPTION_KEY_ID")?.trim() || "1", key };
}

function seal(plaintext: string, id: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, VERSION, id, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

// Every column the app seal()s (grep apps/dashboard for "seal("), including the
// webhook URLs customers paste in the widget, which no reconnect re-saves. Each
// table keys its rows on `id`.
const COLUMNS: PgColumn[] = [
  workspaces.slackBotToken,
  workspaces.linearAccessToken,
  workspaces.jiraAccessToken,
  workspaces.jiraRefreshToken,
  workspaces.hubspotAccessToken,
  workspaces.hubspotRefreshToken,
  workspaces.salesforceAccessToken,
  workspaces.salesforceRefreshToken,
  workspaces.teamsWebhookUrl,
  accounts.slackWebhookUrl,
  accounts.teamsWebhookUrl,
  integrationConnections.accessToken,
  integrationConnections.refreshToken,
];

async function main() {
  const { id, key } = loadKey();

  let sealed = 0;
  let skipped = 0;
  for (const col of COLUMNS) {
    const name = sql.identifier(col.name);
    const rows = (await db.execute(
      sql`SELECT id, ${name} AS value FROM ${col.table} WHERE ${name} IS NOT NULL`,
    )) as unknown as Array<{ id: string; value: string }>;
    for (const row of rows) {
      if (row.value.startsWith(`${PREFIX}:`)) {
        skipped++;
        continue;
      }
      // Only while it still holds what was read: the app may have rotated it
      // since (a token refresh), sealed already.
      await db.execute(
        sql`UPDATE ${col.table} SET ${name} = ${seal(row.value, id, key)} WHERE id = ${row.id} AND ${name} = ${row.value}`,
      );
      sealed++;
    }
  }

  console.log(`[backfill] sealed ${sealed} secret(s), skipped ${skipped} already-encrypted, across ${COLUMNS.length} column(s).`);
  process.exit(0);
}

main().catch(err => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});
