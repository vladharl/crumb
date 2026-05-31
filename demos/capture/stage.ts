import { execSync } from "node:child_process";
import { PG_CONTAINER, PG_USER, PG_DB, WORKSPACE_SLUG } from "./config";

// Demo-ONLY database staging. Runs AFTER `pnpm db:seed` and is never run by the
// e2e suite — so the canonical seed (packages/db/src/seed.ts) stays test-safe
// while the captured footage shows a fully "connected + shipped" workspace.
//
// Everything here renders from DB state alone (verified against source):
//   - workspaces.{linear,github,slack}* → Settings → Integrations "Connected"
//     pills + the thread's Engineering card "create/linked" state. The connection
//     check is `!!token` / `!!installId` (truthy), so fake values are fine; we
//     never make a live provider call during capture, so the tokens are never
//     decrypted or sent on the wire.
//   - items.external* on the hero FB-247 → the linked Linear ticket card
//     (ExternalTicketTile state c). Pure DB, no tier/plan gate.
//   - initiative_suggestions (pending) on FB-240 → the "Suggested initiative"
//     AI card in the thread + the ✨ chip in the inbox. Pure DB read in
//     ThreadViewTile/InboxTableTile — no isCloud() gate on display.
//
// Idempotent: seed wipes items (cascading initiative_suggestions) and re-inserts
// the workspace fresh each run, so re-staging just re-applies these UPDATEs/INSERT.

function psql(sql: string): string {
  const cmd = `docker exec -i ${PG_CONTAINER} psql -v ON_ERROR_STOP=1 -tA -U ${PG_USER} -d ${PG_DB} -c "${sql.replace(/"/g, '\\"')}"`;
  return execSync(cmd, { encoding: "utf8" }).trim();
}

const WS = `(SELECT id FROM workspaces WHERE slug='${WORKSPACE_SLUG}')`;

const STATEMENTS: string[] = [
  // ── Connected integrations (Linear + GitHub + Slack) ──────────
  `UPDATE workspaces SET
     linear_access_token = 'demo-linear-token',
     linear_team_id      = 'team_eng_demo',
     linear_team_name    = 'Engineering',
     linear_installed_at = now() - interval '47 days',
     github_app_install_id      = 'demo-gh-install',
     github_app_install_account = 'southbeam',
     github_default_repo        = 'southbeam/app',
     github_installed_at        = now() - interval '47 days',
     slack_bot_token   = 'demo-slack-token',
     slack_team_name   = 'Southbeam',
     slack_bot_user_id = 'U0DEMO',
     slack_installed_at = now() - interval '47 days'
   WHERE slug='${WORKSPACE_SLUG}'`,

  // ── Stage the hero initiative as Private ──────────────────────
  // "CSV & funnel exports" (IN-1, linked to FB-247) starts off the public
  // roadmap so Act 2's climactic action — the vendor flipping it Public — is the
  // customer's exact ask landing on the roadmap they can see. The OTHER seeded
  // initiatives stay public, so Act 1's customer roadmap is still populated.
  `UPDATE initiatives SET is_public=false WHERE workspace_id=${WS} AND short_id='IN-1'`,

  // ── Hero FB-247: an already-created Linear ticket ─────────────
  // external_synced_at = now() → fresh, so no "syncing…" badge (clean card).
  `UPDATE items SET
     external_provider  = 'linear',
     external_ticket_id = 'ENG-482',
     external_ticket_url= 'https://linear.app/southbeam/issue/ENG-482/per-cohort-csv-export',
     external_status    = 'In Progress',
     external_synced_at = now()
   WHERE workspace_id=${WS} AND short_id='FB-247'`,

  // ── AI initiative suggestion on FB-240 ───────────────────────
  // Unlink it first so the "Suggested initiative" card is meaningful (an
  // un-triaged item the AI is proposing a home for), then add the pending guess.
  `UPDATE items SET initiative_id=NULL WHERE workspace_id=${WS} AND short_id='FB-240'`,
  `DELETE FROM initiative_suggestions WHERE item_id IN (SELECT id FROM items WHERE workspace_id=${WS})`,
  `INSERT INTO initiative_suggestions (item_id, initiative_id, confidence, reason, status, model)
     SELECT i.id, n.id, 0.82,
            'Locale + date-formatting bug — fits the Mobile & localization polish initiative.',
            'pending', 'claude-haiku-4-5-20251001'
     FROM items i, initiatives n
     WHERE i.workspace_id=${WS} AND i.short_id='FB-240'
       AND n.workspace_id=${WS} AND n.short_id='IN-5'`,
];

function main(): void {
  console.log("[demos] staging demo-only DB state (integrations, linked ticket, AI suggestion)…");
  const wsId = psql(`SELECT id FROM workspaces WHERE slug='${WORKSPACE_SLUG}' LIMIT 1`);
  if (!wsId) {
    throw new Error(`[demos] workspace '${WORKSPACE_SLUG}' not found — run \`pnpm db:seed\` first.`);
  }
  for (const sql of STATEMENTS) psql(sql);

  // Verify the bits that must render on camera.
  const linear = psql(`SELECT linear_access_token IS NOT NULL FROM workspaces WHERE slug='${WORKSPACE_SLUG}'`);
  const ticket = psql(`SELECT external_ticket_id FROM items WHERE workspace_id=${WS} AND short_id='FB-247'`);
  const sugg = psql(`SELECT count(*) FROM initiative_suggestions WHERE item_id IN (SELECT id FROM items WHERE workspace_id=${WS})`);
  const heroPub = psql(`SELECT is_public FROM initiatives WHERE workspace_id=${WS} AND short_id='IN-1'`);
  const pubCount = psql(`SELECT count(*) FROM initiatives WHERE workspace_id=${WS} AND is_public AND roadmap_column IS NOT NULL`);
  console.log(`[demos]   linear_connected=${linear}  FB-247_ticket=${ticket}  ai_suggestions=${sugg}  IN-1_public=${heroPub}  public_roadmap_items=${pubCount}`);
  if (linear !== "t" || ticket !== "ENG-482" || sugg !== "1" || heroPub !== "f" || Number(pubCount) < 1) {
    throw new Error("[demos] staging verification failed — see values above.");
  }
  console.log("[demos] staging done.");
}

main();
