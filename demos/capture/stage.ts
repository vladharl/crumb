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

  // ── First-run tour: OFF for the seeded team ───────────────────
  // guide_completed_at has no seed default (null), so the onboarding tour would
  // auto-open over every captured screen. Mark the whole team as done here; the
  // dedicated tour shot (capture/features.ts) flips one user back to null on its
  // own, captures the spotlight, then restores it.
  `UPDATE workspace_users SET guide_completed_at = now() - interval '21 days' WHERE workspace_id=${WS}`,

  // ── Merged inbox: two pending captures awaiting triage ────────
  // The new Inbox folds in forwarded feedback (email / Slack / extension) as a
  // "Needs triage" card at the top. The seed creates none, so stage two: one
  // email with an AI-suggested account match, one Slack note from an unknown
  // sender (the "Unknown customer" state). Idempotent: clear ours first.
  `DELETE FROM inbound_captures WHERE workspace_id=${WS}`,
  `INSERT INTO inbound_captures (workspace_id, source, from_email, from_name, subject, body, suggested_account_name, suggested_confidence, status, created_at)
     VALUES (${WS}, 'email', 'priya@lumenhealth.com', 'Priya Anand', 'Re: CSV export keeps timing out',
       'Forwarded from support: the cohort CSV export times out on our larger date ranges. Anything over about 90 days just spins. Could it run in the background and email a download link when it is ready?',
       'Lumen Health', 0.86, 'pending', now() - interval '2 hours')`,
  `INSERT INTO inbound_captures (workspace_id, source, from_name, body, status, created_at)
     VALUES (${WS}, 'slack', 'Dana, shared channel',
       'Heads up from the shared Slack: a customer asked twice this week whether the widget launcher can sit bottom-left instead of bottom-right. Small ask, but it keeps coming up.',
       'pending', now() - interval '38 minutes')`,
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
  const tourOff = psql(`SELECT count(*) FROM workspace_users WHERE workspace_id=${WS} AND guide_completed_at IS NULL`);
  const captures = psql(`SELECT count(*) FROM inbound_captures WHERE workspace_id=${WS} AND status='pending'`);
  console.log(`[demos]   linear_connected=${linear}  FB-247_ticket=${ticket}  ai_suggestions=${sugg}  IN-1_public=${heroPub}  public_roadmap_items=${pubCount}  tour_pending_users=${tourOff}  pending_captures=${captures}`);
  if (linear !== "t" || ticket !== "ENG-482" || sugg !== "1" || heroPub !== "f" || Number(pubCount) < 1 || tourOff !== "0" || captures !== "2") {
    throw new Error("[demos] staging verification failed — see values above.");
  }
  console.log("[demos] staging done.");
}

main();
