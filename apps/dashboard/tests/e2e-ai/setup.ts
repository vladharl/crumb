import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Global setup for the AI (cloud-tier) e2e suite. Same shape as tests/e2e/
// setup.ts, but additionally bumps the seeded `southbeam` workspace to a paid
// active plan so `hasFeature(ws,"ai")` is true at CRUMB_TIER=cloud (the AI
// config's webServer sets the tier + points the AI base URLs at the stub).

const REPO_ROOT = resolve(__dirname, "../../../..");
const STORAGE_PATH = resolve(__dirname, ".auth/admin.json");

function exec(cmd: string): string {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function psql(sql: string): string {
  return exec(`docker exec -i crumb-postgres psql -tA -U crumb -d crumb -c "${sql.replace(/"/g, '\\"')}"`);
}

export default async function globalSetup(): Promise<void> {
  console.log("[e2e-ai setup] applying migrations…");
  exec("pnpm db:migrate");

  console.log("[e2e-ai setup] reseeding DB…");
  exec("pnpm db:seed");

  // Light up AI: a paid, active plan. At CRUMB_TIER=cloud this makes
  // workspacePlan() → "growth" and hasFeature(ws,"ai") → true.
  psql("UPDATE workspaces SET plan_id='growth', subscription_status='active' WHERE slug='southbeam'");

  const wsId = psql("SELECT id FROM workspaces WHERE slug='southbeam' LIMIT 1");
  const userId = psql("SELECT id FROM workspace_users WHERE email='lina@southbeam.io' AND workspace_id='" + wsId + "' LIMIT 1");
  if (!wsId || !userId) throw new Error("[e2e-ai setup] seeded admin row not found");

  // Expose the workspace signing secret so AI specs can mint a widget JWT and
  // submit items via the capture path (which fires triage + embeddings).
  const signingSecret = psql("SELECT signing_secret FROM workspaces WHERE slug='southbeam' LIMIT 1");
  mkdirSync(resolve(__dirname, ".auth"), { recursive: true });
  writeFileSync(resolve(__dirname, ".auth/ctx.json"), JSON.stringify({ signingSecret, wsId }), "utf8");

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  psql(`DELETE FROM sessions WHERE workspace_user_id='${userId}'`);
  psql(`INSERT INTO sessions (workspace_id, workspace_user_id, token_hash, expires_at) VALUES ('${wsId}', '${userId}', '${tokenHash}', now() + interval '1 day')`);

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

  console.log("[e2e-ai setup] storageState written →", STORAGE_PATH);
}
