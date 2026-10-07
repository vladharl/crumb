import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Global setup. Runs once before all e2e tests.
//
// Responsibilities:
//   1. Re-seed the docker Postgres to a known state. Without this, FB-N
//      ids leak across runs and `nextItemSeq` collides with anything an
//      earlier test created. The seed at `packages/db/src/seed.ts` is
//      idempotent — it wipes then reinserts the Southbeam fixture.
//   2. Create a session token for the seeded admin (`lina@southbeam.io`)
//      directly in the DB and persist it as a Playwright storageState.
//      All tests then start signed-in via the `crumb_session` cookie,
//      skipping the magic-link round-trip (login flow gets its own
//      dedicated test in login.spec.ts).

const REPO_ROOT = resolve(__dirname, "../../../..");
const STORAGE_PATH = resolve(__dirname, ".auth/admin.json");

function exec(cmd: string): string {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function psql(sql: string): string {
  // Use single-quotes around the SQL; embedded values must avoid them.
  // Tests don't pass user input to this helper.
  return exec(`docker exec -i crumb-postgres psql -tA -U crumb -d crumb -c "${sql.replace(/"/g, '\\"')}"`);
}

export default async function globalSetup(): Promise<void> {
  // Bring the schema to head first — the migrations carry `CREATE EXTENSION
  // vector` + the new tables, so a fresh (or behind) DB is migrated before the
  // seed runs. Idempotent via the drizzle journal.
  console.log("[e2e setup] applying migrations…");
  exec("pnpm db:migrate");

  // Re-seed. The seed script wipes then re-inserts; idempotent.
  console.log("[e2e setup] reseeding DB…");
  exec("pnpm db:seed");

  // Look up the seeded admin's workspace + user id.
  const wsId = psql("SELECT id FROM workspaces WHERE slug='southbeam' LIMIT 1");
  const userId = psql("SELECT id FROM workspace_users WHERE email='lina@southbeam.io' AND workspace_id='" + wsId + "' LIMIT 1");
  if (!wsId || !userId) throw new Error("[e2e setup] seeded admin row not found");

  // The seeded users are fresh (guide_completed_at IS NULL), so the
  // first-sign-in tour would auto-open and its modal overlay intercepts every
  // click. E2e tests aren't first-run users — mark the tour done. (The tour
  // itself is covered by its own relaunch affordance, not blocked by this.)
  psql(`UPDATE workspace_users SET guide_completed_at = now() WHERE workspace_id='${wsId}'`);

  // The seed reinserts the workspace with no widget ping, but its items came in
  // through the widget. Stamp it, so "Install the widget" reads as Done.
  psql(`UPDATE workspaces SET widget_first_ping_at = now() WHERE id='${wsId}'`);

  // Mint a 24h session token. The dashboard verifies sha256(cookieValue)
  // against sessions.token_hash, so we hash + insert here.
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  psql(`DELETE FROM sessions WHERE workspace_user_id='${userId}'`);
  psql(`INSERT INTO sessions (workspace_id, workspace_user_id, token_hash, expires_at) VALUES ('${wsId}', '${userId}', '${tokenHash}', now() + interval '1 day')`);

  // Persist as Playwright storageState so all tests reuse it.
  mkdirSync(resolve(__dirname, ".auth"), { recursive: true });
  writeFileSync(STORAGE_PATH, JSON.stringify({
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
  }, null, 2));

  console.log("[e2e setup] storageState written →", STORAGE_PATH);
}
