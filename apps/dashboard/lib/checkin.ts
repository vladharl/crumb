import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@crumb/db";
import { signReplyToken } from "./reply-token";
import { sendCheckin } from "./email";
import { originFromHeaders } from "./origin";
import { log } from "./log";

// The check-in email to a new admin whose workspace went quiet after signup:
// three one-click answers, each a link to /api/v1/checkin that tells the
// operator (CRUMB_OPS_EMAIL) which one they picked.

export const CHECKIN_ANSWERS = {
  fit: {
    button: "Crumb doesn't fit my use case",
    ops: "Product doesn't fit my use case",
    title: "Thanks for telling us",
    text: "If you have a minute, reply to the email with what you were hoping Crumb would do. It goes straight to the team.",
  },
  comparing: {
    button: "I'm comparing a few options",
    ops: "Comparing different options",
    title: "Makes sense",
    text: "Take your time. If a question would help you decide, reply to the email and the team will answer it.",
  },
  chat: {
    button: "I'd love to chat with your team",
    ops: "Would love to chat with the team",
    title: "We'll be in touch",
    text: "Someone from the Crumb team will email you within a day to find a time.",
  },
} as const;

export type CheckinAnswer = keyof typeof CHECKIN_ANSWERS;

export const isCheckinAnswer = (a: string): a is CheckinAnswer => Object.hasOwn(CHECKIN_ANSWERS, a);

// Signed like reply addresses (the workspace signing secret), so a link only
// ever speaks for the member it was sent to.
export const checkinPayload = (workspaceUserId: string) => `checkin:${workspaceUserId}`;

export function checkinLinks(origin: string, workspaceUserId: string, signingSecret: string) {
  const t = signReplyToken(checkinPayload(workspaceUserId), signingSecret);
  return (Object.keys(CHECKIN_ANSWERS) as CheckinAnswer[]).map((a) => ({
    label: CHECKIN_ANSWERS[a].button,
    url: `${origin}/api/v1/checkin?u=${workspaceUserId}&a=${a}&t=${t}`,
  }));
}

// ─── the 24-hour sweep (POST /api/v1/internal/checkins, hourly) ──
// Workspaces under 72 hours old that have gone quiet: their latest activity
// (signup, or the newest item, reply or changelog entry; the sample data is
// backdated before signup) is 24+ hours old, and no widget ping. Their first
// admin gets the check-in, once (workspaces.checkin_sent_at). The 72-hour edge
// keeps switching it on from emailing every old, quiet workspace.
//
// Off unless CRUMB_CHECKIN_EMAILS=1 and CRUMB_OPS_EMAIL (the Reply-To) is set;
// while off, a run only reports who would get it.

export const checkinsEnabled = () =>
  process.env.CRUMB_CHECKIN_EMAILS?.trim() === "1" && !!process.env.CRUMB_OPS_EMAIL?.trim();

type Due = { workspace_id: string; workspace: string; signing_secret: string; member_id: string; name: string; email: string };

export async function sendCheckins(opts: { dryRun: boolean; now?: Date }) {
  const now = (opts.now ?? new Date()).toISOString();
  const due = (await db.execute(sql`
    SELECT DISTINCT ON (w.id) w.id AS workspace_id, w.name AS workspace, w.signing_secret,
      wu.id AS member_id, wu.name, wu.email
    FROM workspaces w
    JOIN workspace_users wu ON wu.workspace_id = w.id AND wu.role = 'admin'
    WHERE w.checkin_sent_at IS NULL
      AND w.widget_first_ping_at IS NULL
      AND w.created_at > ${now}::timestamptz - interval '72 hours'
      AND GREATEST(
        w.created_at,
        (SELECT max(i.created_at) FROM items i WHERE i.workspace_id = w.id),
        (SELECT max(r.created_at) FROM replies r JOIN items i ON i.id = r.item_id WHERE i.workspace_id = w.id),
        (SELECT max(c.created_at) FROM changelog_entries c WHERE c.workspace_id = w.id)
      ) <= ${now}::timestamptz - interval '24 hours'
    ORDER BY w.id, wu.created_at
  `)) as unknown as Due[];

  const ops = process.env.CRUMB_OPS_EMAIL?.trim();
  const origin = originFromHeaders(new Headers());
  const dryRun = opts.dryRun || !checkinsEnabled() || !origin;
  let sent = 0;
  for (const d of dryRun ? [] : due) {
    // Claim first, so an overlapping run can't send it twice.
    const claimed = (await db.execute(sql`
      UPDATE workspaces SET checkin_sent_at = now() WHERE id = ${d.workspace_id} AND checkin_sent_at IS NULL RETURNING id
    `)) as unknown as unknown[];
    if (claimed.length === 0) continue;
    const result = await sendCheckin({
      to: d.email,
      replyTo: ops!,
      firstName: d.name.trim().split(/\s+/)[0] || "there",
      workspaceName: d.workspace,
      buttons: checkinLinks(origin!, d.member_id, d.signing_secret),
    }).catch((err) => ({ ok: false as const, error: String(err) }));
    if (result.ok) { sent++; continue; }
    // Hand it back to the next run.
    await db.execute(sql`UPDATE workspaces SET checkin_sent_at = NULL WHERE id = ${d.workspace_id}`);
    log.error("check-in not sent", { scope: "crumb/checkin", workspace: d.workspace, error: result.error });
  }
  return {
    enabled: checkinsEnabled(),
    dryRun,
    due: due.map((d) => ({ workspace: d.workspace, email: d.email })),
    sent,
  };
}
