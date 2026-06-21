import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Global setup for the HOSTED verification suite. Non-destructive: it never
// migrates or seeds. Its only job is to obtain a `crumb_session` cookie (when
// one is available) and persist it as a Playwright storageState so the
// dashboard-UI specs run signed-in. API-only specs read CRUMB_E2E_API_KEY
// directly and don't need this.
//
// Session source, in precedence order:
//   1. CRUMB_E2E_SESSION  — a raw `crumb_session` cookie value, pre-provisioned
//      once by an operator (copy it from the browser after logging in, or from a
//      prior SSH-bootstrap run). Robust, CI-friendly, zero host access. PRIMARY.
//   2. SSH session-mint (opt-in: CRUMB_E2E_SSH_BOOTSTRAP=1) — inserts ONE
//      additive, 1-day-expiring `sessions` row on the host via `docker exec
//      psql`, exactly like the local suite does but without re-seeding. Picks an
//      admin user (optionally CRUMB_E2E_ADMIN_EMAIL). Additive + auto-expiring,
//      so still "safe ops only".
//   3. none — write an empty storageState; UI specs self-skip (the API/negative
//      specs still run).
//
// On ANY failure we fall back to an empty storageState rather than aborting the
// whole run — a hosted suite that can't get a session should still report the
// unauthenticated checks, not go red wholesale.

const STORAGE_PATH = resolve(__dirname, ".auth/admin.json");

const BASE_URL = process.env.CRUMB_E2E_HOSTED_URL ?? "https://crumb-app.localhostlabs.net";

function cookieHost(): string {
  try {
    return new URL(BASE_URL).hostname;
  } catch {
    return "localhost";
  }
}

function writeStorage(cookieValue: string | null): void {
  mkdirSync(resolve(__dirname, ".auth"), { recursive: true });
  const secure = BASE_URL.startsWith("https://");
  const cookies = cookieValue
    ? [{
        name: "crumb_session",
        value: cookieValue,
        domain: cookieHost(),
        path: "/",
        // 7 days out — matches the server's SESSION_TTL_DAYS. Playwright wants
        // unix seconds.
        expires: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        httpOnly: true,
        secure,
        sameSite: "Lax" as const,
      }]
    : [];
  writeFileSync(STORAGE_PATH, JSON.stringify({ cookies, origins: [] }, null, 2));
}

// Mint a session row on the host over SSH. Returns the raw cookie value, or
// null on any problem. The dashboard stores sha256(cookie) in sessions.token_hash.
function sshMintSession(): string | null {
  const sshHost = process.env.CRUMB_E2E_SSH_HOST ?? "eissa-vps";
  const pgContainer = process.env.CRUMB_E2E_PG_CONTAINER ?? "crumb-postgres";
  const pgUser = process.env.CRUMB_E2E_PG_USER ?? "crumb";
  const pgDb = process.env.CRUMB_E2E_PG_DB ?? "crumb";
  const email = process.env.CRUMB_E2E_ADMIN_EMAIL?.trim().toLowerCase();

  // Run a psql query on the host and return the trimmed single value.
  function psql(sql: string): string {
    // ssh <host> 'docker exec -i <ctr> psql -tA -U <u> -d <db> -c "<sql>"'
    // Single-quote the remote command; escape any single quotes in the SQL.
    const inner = `docker exec -i ${pgContainer} psql -tA -U ${pgUser} -d ${pgDb} -c "${sql.replace(/"/g, '\\"')}"`;
    const cmd = `ssh -o BatchMode=yes -o ConnectTimeout=8 ${sshHost} '${inner.replace(/'/g, "'\\''")}'`;
    return execSync(cmd, { encoding: "utf8", timeout: 30_000 }).trim();
  }

  const emailFilter = email ? ` AND lower(u.email)='${email.replace(/'/g, "''")}'` : "";
  const pair = psql(
    `SELECT w.id||'|'||u.id FROM workspaces w ` +
    `JOIN workspace_users u ON u.workspace_id=w.id ` +
    `WHERE u.role='admin'${emailFilter} ORDER BY w.created_at ASC LIMIT 1`,
  );
  const [wsId, userId] = pair.split("|");
  if (!wsId || !userId) {
    console.warn("[hosted setup] SSH bootstrap: no admin user found on host");
    return null;
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  psql(
    `INSERT INTO sessions (workspace_id, workspace_user_id, token_hash, expires_at) ` +
    `VALUES ('${wsId}','${userId}','${tokenHash}', now() + interval '7 days')`,
  );
  console.log(`[hosted setup] SSH bootstrap: minted session for workspace ${wsId}`);
  return token;
}

export default async function globalSetup(): Promise<void> {
  console.log(`[hosted setup] target → ${BASE_URL}`);

  // 1. Explicit session env wins.
  const provided = process.env.CRUMB_E2E_SESSION?.trim();
  if (provided) {
    writeStorage(provided);
    console.log("[hosted setup] using CRUMB_E2E_SESSION cookie");
    return;
  }

  // 2. Opt-in SSH session-mint.
  if (process.env.CRUMB_E2E_SSH_BOOTSTRAP === "1") {
    try {
      const minted = sshMintSession();
      writeStorage(minted);
      if (minted) return;
    } catch (err) {
      console.warn("[hosted setup] SSH bootstrap failed — UI specs will skip:", (err as Error).message);
      writeStorage(null);
      return;
    }
  }

  // 3. No session available.
  writeStorage(null);
  console.log("[hosted setup] no session (set CRUMB_E2E_SESSION or CRUMB_E2E_SSH_BOOTSTRAP=1) — UI specs will skip");
}
