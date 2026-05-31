import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  PG_CONTAINER, PG_USER, PG_DB, ADMIN_EMAIL, WORKSPACE_SLUG,
} from "./config";

// Run a single SQL statement against the docker Postgres — identical mechanism
// to the e2e global setup (apps/dashboard/tests/e2e/setup.ts), so we don't add
// a `pg` dependency just for this.
function psql(sql: string): string {
  const cmd = `docker exec -i ${PG_CONTAINER} psql -tA -U ${PG_USER} -d ${PG_DB} -c "${sql.replace(/"/g, '\\"')}"`;
  return execSync(cmd, { encoding: "utf8" }).trim();
}

export interface StorageState {
  cookies: unknown[];
  origins: unknown[];
}

// Mint a 24h session for the seeded admin and return it as a Playwright
// storageState object. The dashboard verifies sha256(cookieValue) against
// sessions.token_hash, so we hash + insert here — skipping the magic-link flow.
// Assumes the DB is already seeded (`pnpm db:seed`); the `all` script does that.
export function createAuthState(): StorageState {
  const wsId = psql(`SELECT id FROM workspaces WHERE slug='${WORKSPACE_SLUG}' LIMIT 1`);
  const userId = wsId
    ? psql(`SELECT id FROM workspace_users WHERE email='${ADMIN_EMAIL}' AND workspace_id='${wsId}' LIMIT 1`)
    : "";
  if (!wsId || !userId) {
    throw new Error(
      `[demos] seeded admin not found (workspace='${WORKSPACE_SLUG}', email='${ADMIN_EMAIL}'). ` +
      `Is Postgres up and seeded? Try \`pnpm db:up && pnpm db:seed\`.`,
    );
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  psql(`DELETE FROM sessions WHERE workspace_user_id='${userId}'`);
  psql(
    `INSERT INTO sessions (workspace_id, workspace_user_id, token_hash, expires_at) ` +
    `VALUES ('${wsId}', '${userId}', '${tokenHash}', now() + interval '1 day')`,
  );

  return {
    cookies: [{
      name: "crumb_session",
      value: token,
      domain: "localhost",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 86400,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    }],
    origins: [],
  };
}
