import "server-only";
import { and, desc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import {
  db, accounts, accountUsers, items, notificationPreferences, statusEvents, workspaceUsers, workspaces,
} from "@crumb/db";
import { CLOSED_STATUSES, statusLabel } from "@crumb/ui";
import { sendDigest, sendVendorNudge } from "./email";
import { vendorFooter, type DigestLine, type DigestSection } from "./email/template";
import { escapeSlackText, resolveSlackUserId, sendDirectMessage } from "./slack/notify";
import { openNullable } from "./crypto-at-rest";
import { clearProviderInstall, isSlackRevokedError } from "./integrations/revoke";
import { originFromHeaders } from "./origin";
import { checkRateLimitAsync } from "./rate-limit";
import { lastTurnSideSql, loopOpenSql, notMergedSql } from "./loop-sql";
import { loopTurn, waitingDays, waitingSince } from "./loop";
import { byPriorityDesc, formatArr, priority } from "./priority";
import { SAMPLE_ACCOUNT_EXTERNAL_ID } from "./samples";
import { log } from "./log";

// A member who was invited but never accepted: an unused sign-in link, no
// used one, and no session. Nudges and digests skip them, so a mistyped or
// ignored invite never receives customer names, ARR or feedback. (Sessions
// alone can't tell: they're deleted on sign-out and expiry; used links stay.)
// Raw refs stay qualified, as magic_tokens and sessions both have an "id".
const acceptedMemberSql = sql`NOT (
  EXISTS (SELECT 1 FROM magic_tokens t WHERE t.workspace_user_id = "workspace_users"."id" AND t.consumed_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM magic_tokens t WHERE t.workspace_user_id = "workspace_users"."id" AND t.consumed_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.workspace_user_id = "workspace_users"."id")
)`;

// What reaches the vendor team: the real-time nudges (customer reply, mention,
// new submission, assignment, engineering done) and the daily/weekly digest.
// Everything here is best-effort: it never throws, and callers `void` it.

// ─── the dispatcher ──────────────────────────────────────────
// Every real-time nudge goes through nudge(): who takes it (their
// notification_preferences), where (email, a Slack DM, or nowhere), Slack with
// an email fallback, and dropping a Slack install that stopped working.

export type NudgePref = "replyRealtime" | "mentionRealtime" | "newSubmissionRealtime" | "assignedRealtime";

type SlackBlock = Record<string, unknown>;

/**
 * Where a member takes this kind of nudge, or null for nowhere. A saved row is
 * honoured as saved. Without one the column defaults apply (on, by email),
 * except new-submission alerts: there's no account owner to scope those to,
 * so until a member chooses, only admins get them.
 */
export function nudgeChannel(
  pref: NudgePref,
  role: string,
  saved: { on: boolean; delivery: string } | null,
): "email" | "slack" | null {
  if (!saved) return pref === "newSubmissionRealtime" && role !== "admin" ? null : "email";
  if (!saved.on || saved.delivery === "none") return null;
  return saved.delivery === "slack" ? "slack" : "email";
}

export async function nudge(opts: {
  workspaceId: string;
  pref: NudgePref;
  /** Members to try, in order: the first pool where anyone takes it gets it. */
  pools: SQL[];
  /** The member whose own action this is; never told about it. */
  skip?: string | null;
  /** The DM (mrkdwn; escape anything a customer wrote). */
  slack: { text: string; blocks?: SlackBlock[] };
  email: (to: string, workspaceName: string) => Promise<unknown>;
}): Promise<void> {
  try {
    const [ws] = await db
      .select({ name: workspaces.name, slackBotToken: workspaces.slackBotToken })
      .from(workspaces)
      .where(eq(workspaces.id, opts.workspaceId))
      .limit(1);
    if (!ws) return;
    // A token that won't decrypt (a rotated key) means no Slack, not no nudge.
    let botToken: string | null = null;
    try { botToken = openNullable(ws.slackBotToken); } catch { botToken = null; }

    for (const pool of opts.pools) {
      const members = await db
        .select({
          id: workspaceUsers.id,
          email: workspaceUsers.email,
          role: workspaceUsers.role,
          slackUserId: workspaceUsers.slackUserId,
          slackLookupFailedAt: workspaceUsers.slackLookupFailedAt,
          saved: notificationPreferences.workspaceUserId,
          on: notificationPreferences[opts.pref],
          delivery: notificationPreferences.delivery,
        })
        .from(workspaceUsers)
        .leftJoin(notificationPreferences, eq(notificationPreferences.workspaceUserId, workspaceUsers.id))
        .where(and(eq(workspaceUsers.workspaceId, opts.workspaceId), pool, acceptedMemberSql));
      const takers = members.flatMap(m => {
        if (m.id === opts.skip) return [];
        const channel = nudgeChannel(opts.pref, m.role, m.saved ? { on: !!m.on, delivery: m.delivery ?? "email" } : null);
        return channel ? [{ ...m, channel }] : [];
      });
      if (takers.length === 0) continue;
      await Promise.all(takers.map(m => deliverNudge(opts, ws.name, botToken, m)));
      return;
    }
  } catch (err) {
    log.error("vendor nudge failed", { scope: "crumb/notify", pref: opts.pref, err });
  }
}

async function deliverNudge(
  opts: Parameters<typeof nudge>[0],
  workspaceName: string,
  botToken: string | null,
  m: { id: string; email: string; slackUserId: string | null; slackLookupFailedAt: Date | null; channel: "email" | "slack" },
): Promise<void> {
  if (m.channel === "slack" && botToken) {
    const slackUserId = await resolveSlackUserId({
      botToken,
      workspaceUserId: m.id,
      email: m.email,
      lastFailedAt: m.slackLookupFailedAt,
      cachedUserId: m.slackUserId,
    });
    if (slackUserId) {
      const sent = await sendDirectMessage({ botToken, slackUserId, text: opts.slack.text, blocks: opts.slack.blocks });
      if (sent.ok) return;
      // A revoked or uninstalled app: clear the install so the workspace stops
      // trying and Settings shows it disconnected. The email still goes.
      if (isSlackRevokedError(sent.error)) {
        await clearProviderInstall(opts.workspaceId, "slack").catch(() => {});
      }
      log.warn("slack DM failed; falling back to email", { scope: "crumb/slack", workspaceUserId: m.id, error: sent.error });
    }
    // No Slack user or a failed DM: better to over-deliver than drop it.
  }
  await opts.email(m.email, workspaceName).catch(err => {
    log.error("vendor nudge email failed", { scope: "crumb/notify", workspaceUserId: m.id, err });
  });
}

// No request here, so links use CRUMB_APP_URL, or go without when it's unset.
function threadUrl(shortId: string): string | null {
  const origin = originFromHeaders(new Headers());
  return origin ? `${origin}/thread/${shortId}` : null;
}

const esc = escapeSlackText;
const slackLink = (url: string | null) => (url ? `\n<${url}|Open thread →>` : "");

// ─── new submission ──────────────────────────────────────────
// One alert per item (createItem calls this once, for items it announces) to
// each teammate who takes them, never the teammate who created it. At most 30
// at once per workspace, then one every two minutes: the widget endpoint is
// public, so a flood of submissions must not become a flood of email (or spend
// the provider's quota). The rest still reach the inbox and the digest.
const NEW_SUBMISSION_ALERTS = { capacity: 30, refillPerSec: 30 / 3600 };

export async function notifyNewSubmission(input: { workspaceId: string; itemId: string }): Promise<void> {
  try {
    if (!(await checkRateLimitAsync(`new-alert:ws:${input.workspaceId}`, NEW_SUBMISSION_ALERTS)).ok) return;
    const [it] = await db
      .select({
        shortId: items.shortId,
        title: items.title,
        body: items.body,
        accountName: accounts.name,
        submitterName: accountUsers.name,
        // A teammate who created it is the opening status event's actor; null
        // for a customer's own submission.
        creatorId: sql<string | null>`(
          SELECT se.by_workspace_user_id FROM status_events se
          WHERE se.item_id = items.id AND se.from_status IS NULL
          ORDER BY se.at LIMIT 1
        )`,
      })
      .from(items)
      .innerJoin(accounts, eq(accounts.id, items.accountId))
      .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
      .where(and(eq(items.id, input.itemId), eq(items.workspaceId, input.workspaceId)))
      .limit(1);
    if (!it) return;
    const url = threadUrl(it.shortId);
    await nudge({
      workspaceId: input.workspaceId,
      pref: "newSubmissionRealtime",
      pools: [sql`true`],
      skip: it.creatorId,
      slack: { text: `New feedback from *${esc(it.submitterName)}* at *${esc(it.accountName)}*: _${esc(it.title)}_ (${it.shortId})${slackLink(url)}` },
      email: (to, workspaceName) => sendVendorNudge({
        to,
        workspaceName,
        subject: `New feedback · ${it.shortId} ${it.title}`,
        headline: `New feedback from ${it.submitterName} at ${it.accountName}`,
        itemShortId: it.shortId,
        itemTitle: it.title,
        accountName: it.accountName,
        body: it.body,
        dashboardThreadUrl: url,
      }),
    });
  } catch (err) {
    log.error("new-submission notify failed", { scope: "crumb/notify", err });
  }
}

// ─── assignment ──────────────────────────────────────────────
// Tells the new assignee (assignedRealtime), unless they assigned it to
// themselves. Nobody else: when the assignee won't get it, that's their call.

// The acting teammate's name, for "Ada assigned ... to you".
async function memberName(workspaceId: string, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [m] = await db
    .select({ name: workspaceUsers.name })
    .from(workspaceUsers)
    .where(and(eq(workspaceUsers.id, id), eq(workspaceUsers.workspaceId, workspaceId)))
    .limit(1);
  return m?.name ?? null;
}

export async function notifyAssigned(input: {
  workspaceId: string;
  itemId: string;
  assigneeId: string;
  actorWorkspaceUserId: string | null;
}): Promise<void> {
  if (input.assigneeId === input.actorWorkspaceUserId) return;
  try {
    const [it] = await db
      .select({ shortId: items.shortId, title: items.title, accountName: accounts.name })
      .from(items)
      .innerJoin(accounts, eq(accounts.id, items.accountId))
      .where(and(eq(items.id, input.itemId), eq(items.workspaceId, input.workspaceId)))
      .limit(1);
    if (!it) return;
    const actor = await memberName(input.workspaceId, input.actorWorkspaceUserId);
    const url = threadUrl(it.shortId);
    await nudge({
      workspaceId: input.workspaceId,
      pref: "assignedRealtime",
      pools: [eq(workspaceUsers.id, input.assigneeId)],
      slack: {
        text: (actor ? `*${esc(actor)}* assigned _${esc(it.title)}_ (${it.shortId}) to you` : `_${esc(it.title)}_ (${it.shortId}) was assigned to you`) + slackLink(url),
      },
      email: (to, workspaceName) => sendVendorNudge({
        to,
        workspaceName,
        subject: `Assigned to you · ${it.shortId} ${it.title}`,
        headline: actor ? `${actor} assigned ${it.shortId} to you` : `${it.shortId} was assigned to you`,
        itemShortId: it.shortId,
        itemTitle: it.title,
        accountName: it.accountName,
        dashboardThreadUrl: url,
      }),
    });
  } catch (err) {
    log.error("assignment notify failed", { scope: "crumb/notify", err });
  }
}

// A bulk assign (the inbox bulk bar) tells the assignee once: the usual alert
// for one item, one short list for several, so assigning forty sends one.
export async function notifyAssignedMany(input: {
  workspaceId: string;
  itemIds: string[];
  assigneeId: string;
  actorWorkspaceUserId: string | null;
}): Promise<void> {
  const [only, ...rest] = input.itemIds;
  if (!only || input.assigneeId === input.actorWorkspaceUserId) return;
  if (rest.length === 0) return notifyAssigned({ ...input, itemId: only });
  try {
    const rows = await db
      .select({ shortId: items.shortId, title: items.title, accountName: accounts.name })
      .from(items)
      .innerJoin(accounts, eq(accounts.id, items.accountId))
      .where(and(inArray(items.id, input.itemIds), eq(items.workspaceId, input.workspaceId)))
      .orderBy(desc(items.seq));
    if (rows.length === 0) return;
    const actor = await memberName(input.workspaceId, input.actorWorkspaceUserId);
    const n = `${rows.length} requests`;
    const lines = rows.slice(0, DIGEST_LINES).map(r => ({ shortId: r.shortId, title: r.title, detail: r.accountName, url: threadUrl(r.shortId) }));
    const more = rows.length - lines.length;
    const origin = originFromHeaders(new Headers());
    await nudge({
      workspaceId: input.workspaceId,
      pref: "assignedRealtime",
      pools: [eq(workspaceUsers.id, input.assigneeId)],
      slack: {
        text: [
          actor ? `*${esc(actor)}* assigned ${n} to you:` : `${n} were assigned to you:`,
          ...lines.map(l => `• ${l.url ? `<${l.url}|${l.shortId}>` : l.shortId} _${esc(l.title)}_`),
          ...(more > 0 ? [`And ${more} more in the Inbox.`] : []),
        ].join("\n"),
      },
      email: (to, workspaceName) => sendDigest({
        to,
        workspaceName,
        subject: `Assigned to you · ${n}`,
        eyebrow: "Assigned to you",
        heading: actor ? `${actor} assigned ${n} to you` : `${n} were assigned to you`,
        sections: [{ heading: "Assigned to you", total: rows.length, lines }],
        inboxUrl: origin ? `${origin}/inbox` : null,
        footer: vendorFooter(workspaceName),
      }),
    });
  } catch (err) {
    log.error("assignment notify failed", { scope: "crumb/notify", err });
  }
}

// ─── engineering done ────────────────────────────────────────
// A linked ticket reached a done state (lib/webhooks.ts syncExternalStatus)
// while the loop is still open, so someone should tell the customer: the
// assignee (assignedRealtime), or the admins when it's unassigned or the
// assignee won't get it.

const TRACKERS: Record<string, string> = { linear: "Linear", jira: "Jira", github: "GitHub" };

export async function notifyEngDone(input: { itemIds: string[] }): Promise<void> {
  if (input.itemIds.length === 0) return;
  try {
    const rows = await db
      .select({
        workspaceId: items.workspaceId,
        shortId: items.shortId,
        title: items.title,
        assigneeId: items.assigneeId,
        provider: items.externalProvider,
        accountName: accounts.name,
      })
      .from(items)
      .innerJoin(accounts, eq(accounts.id, items.accountId))
      .where(and(inArray(items.id, input.itemIds), loopOpenSql(items.status)));
    await Promise.all(rows.map(r => {
      const url = threadUrl(r.shortId);
      const headline = `${TRACKERS[r.provider ?? ""] ?? "The tracker"} marked ${r.shortId} done. Tell the customer.`;
      const admins = eq(workspaceUsers.role, "admin");
      return nudge({
        workspaceId: r.workspaceId,
        pref: "assignedRealtime",
        pools: r.assigneeId ? [eq(workspaceUsers.id, r.assigneeId), admins] : [admins],
        slack: { text: `${headline}\n_${esc(r.title)}_${slackLink(url)}` },
        email: (to, workspaceName) => sendVendorNudge({
          to,
          workspaceName,
          subject: headline,
          headline,
          itemShortId: r.shortId,
          itemTitle: r.title,
          accountName: r.accountName,
          dashboardThreadUrl: url,
        }),
      });
    }));
  } catch (err) {
    log.error("eng-done notify failed", { scope: "crumb/notify", err });
  }
}

// ─── digest ──────────────────────────────────────────────────
// The digest cron (app/api/v1/internal/digest) emails each member whose
// digest is due: the loops waiting on the team, the ones assigned to them, and
// what's new and what closed since their last one. last_digest_at is the
// watermark: it moves only when a provider accepted the email, or when there
// was nothing to send.

const HOUR = 3_600_000;
const DIGEST = {
  // At most one per period, with slack for a cron that runs a little early.
  daily: { gap: 20 * HOUR, period: 24 * HOUR, every: "every day", first: "in the last day" },
  weekly: { gap: 6.5 * 24 * HOUR, period: 7 * 24 * HOUR, every: "every week", first: "in the last week" },
} as const;

type Cadence = keyof typeof DIGEST;

/** Whether a member's digest is due, and from when it reports. Pure. */
export function digestWindow(
  frequency: string,
  lastDigestAt: Date | null,
  now: number,
): { cadence: Cadence; since: Date; first: boolean } | null {
  if (frequency !== "daily" && frequency !== "weekly") return null;
  const d = DIGEST[frequency];
  if (lastDigestAt && now - lastDigestAt.getTime() < d.gap) return null;
  return { cadence: frequency, since: lastDigestAt ?? new Date(now - d.period), first: !lastDigestAt };
}

const DIGEST_LINES = 5;
const CLOSED = [...CLOSED_STATUSES];

// One workspace's open loops on the team's turn (highest priority first), and
// its items created and loops closed since `since`.
async function loadDigestData(workspaceId: string, since: Date, now: number) {
  // Samples never send anything (lib/samples.ts).
  const real = sql`${accounts.externalCrmId} IS DISTINCT FROM ${SAMPLE_ACCOUNT_EXTERNAL_ID}`;

  const open = await db
    .select({
      shortId: items.shortId,
      title: items.title,
      status: items.status,
      assigneeId: items.assigneeId,
      createdAt: items.createdAt,
      aiSeverity: items.aiSeverity,
      accountName: accounts.name,
      lastReplySide: lastTurnSideSql(items.id),
      // Fully-qualified refs in these correlated subqueries (see InboxTableTile).
      lastExternalReplyMs: sql<number | null>`(
        SELECT (EXTRACT(EPOCH FROM MAX(r.created_at)) * 1000)::double precision
        FROM replies r WHERE r.item_id = items.id AND r.internal = false
      )`,
      // ARR at stake and reach, as the inbox ranks them: the item plus the
      // duplicates merged into it, each account once.
      arrAtStake: sql<string>`(
        SELECT COALESCE(SUM(a.arr_cents), 0)::bigint
        FROM (SELECT DISTINCT g.account_id FROM items g WHERE g.id = items.id OR g.merged_into_id = items.id) grp
        JOIN accounts a ON a.id = grp.account_id
      )`,
      reachAccounts: sql<number>`(
        SELECT COUNT(DISTINCT g.account_id)::int FROM items g
        WHERE g.id = items.id OR g.merged_into_id = items.id
      )`,
    })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .where(and(eq(items.workspaceId, workspaceId), loopOpenSql(items.status), notMergedSql(items.mergedIntoId), real));

  const waiting = open
    .map(r => {
      const input = {
        arrAtStakeCents: Number(r.arrAtStake),
        reachAccounts: r.reachAccounts,
        aiSeverity: r.aiSeverity,
        status: r.status,
        lastReplySide: r.lastReplySide,
        createdAtIso: r.createdAt.toISOString(),
        lastExternalReplyAtIso: r.lastExternalReplyMs === null ? null : new Date(r.lastExternalReplyMs).toISOString(),
      };
      const days = Math.floor(waitingDays(waitingSince(input), now));
      const detail = [
        r.accountName,
        input.arrAtStakeCents > 0 ? formatArr(input.arrAtStakeCents, " ARR at stake") : null,
        days >= 1 ? `waiting ${days} ${days === 1 ? "day" : "days"}` : null,
      ].filter(Boolean).join(" · ");
      return { ...r, ...priority(input, now), createdAtIso: input.createdAtIso, yours: loopTurn(input) === "yours", detail };
    })
    .filter(r => r.yours)
    .sort(byPriorityDesc);

  const fresh = await db
    .select({ shortId: items.shortId, title: items.title, accountName: accounts.name, at: items.createdAt })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .where(and(eq(items.workspaceId, workspaceId), notMergedSql(items.mergedIntoId), real, gt(items.createdAt, since)))
    .orderBy(desc(items.createdAt));

  const closedAt = sql<Date>`max(${statusEvents.at})`.mapWith(statusEvents.at);
  const closed = await db
    .select({ shortId: items.shortId, title: items.title, status: items.status, accountName: accounts.name, at: closedAt })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .innerJoin(statusEvents, eq(statusEvents.itemId, items.id))
    .where(and(
      eq(items.workspaceId, workspaceId), notMergedSql(items.mergedIntoId), real,
      inArray(items.status, CLOSED), inArray(statusEvents.toStatus, CLOSED), gt(statusEvents.at, since),
    ))
    .groupBy(items.id, accounts.id)
    .orderBy(desc(closedAt));

  return { waiting, fresh, closed };
}

type DigestData = Awaited<ReturnType<typeof loadDigestData>>;

/** One member's sections, empty when there's nothing to tell them. Pure. */
export function digestSections(
  data: DigestData,
  member: { id: string; cadence: Cadence; since: Date; first: boolean },
  origin: string | null,
): DigestSection[] {
  const url = (shortId: string) => (origin ? `${origin}/thread/${shortId}` : null);
  const sections: DigestSection[] = [];
  const add = <T>(heading: string, rows: T[], line: (r: T) => DigestLine) => {
    if (rows.length) sections.push({ heading, total: rows.length, lines: rows.slice(0, DIGEST_LINES).map(line) });
  };
  const loop = (r: DigestData["waiting"][number]) => ({ shortId: r.shortId, title: r.title, detail: r.detail, url: url(r.shortId) });
  const when = member.first ? DIGEST[member.cadence].first : "since your last digest";

  add("Waiting on your team", data.waiting, loop);
  add("Assigned to you and waiting", data.waiting.filter(r => r.assigneeId === member.id), loop);
  add(`New ${when}`, data.fresh.filter(r => r.at > member.since), r => ({
    shortId: r.shortId, title: r.title, detail: r.accountName, url: url(r.shortId),
  }));
  add(`Closed ${when}`, data.closed.filter(r => r.at > member.since), r => ({
    shortId: r.shortId, title: r.title, detail: `${statusLabel(r.status)} · ${r.accountName}`, url: url(r.shortId),
  }));
  return sections;
}

/** What a member's next digest would hold right now, for the Settings preview. */
export async function previewDigest(
  workspaceId: string,
  member: { id: string; frequency: string; lastDigestAt: Date | null },
): Promise<{ waiting: number; sections: DigestSection[] }> {
  const now = Date.now();
  const cadence: Cadence = member.frequency === "weekly" ? "weekly" : "daily";
  const since = member.lastDigestAt ?? new Date(now - DIGEST[cadence].period);
  const data = await loadDigestData(workspaceId, since, now);
  return {
    waiting: data.waiting.length,
    sections: digestSections(data, { id: member.id, cadence, since, first: !member.lastDigestAt }, null),
  };
}

// The watermark. A member without a saved row gets one that keeps the
// defaults they had (new-submission alerts stay admin-only), so recording a
// digest never changes what else reaches them.
async function markDigested(member: { id: string; role: string }, at: Date): Promise<void> {
  await db
    .insert(notificationPreferences)
    .values({ workspaceUserId: member.id, lastDigestAt: at, newSubmissionRealtime: member.role === "admin" })
    .onConflictDoUpdate({ target: notificationPreferences.workspaceUserId, set: { lastDigestAt: at } });
}

// ponytail: an in-process guard, so an overlapping run (a double-fired cron)
// can't send twice. That's enough for one dashboard process; with several,
// claim each member's watermark with a conditional UPDATE before sending.
let digestRunning = false;

// `scope` narrows the members considered (a test keeps to its own workspace).
export async function sendDigests(now = Date.now(), scope?: SQL): Promise<
  { busy: true } | { due: number; sent: number; empty: number; unsent: number }
> {
  if (digestRunning) return { busy: true };
  digestRunning = true;
  try {
    const members = await db
      .select({
        id: workspaceUsers.id,
        workspaceId: workspaceUsers.workspaceId,
        workspaceName: workspaces.name,
        email: workspaceUsers.email,
        role: workspaceUsers.role,
        frequency: notificationPreferences.digestFrequency,
        lastDigestAt: notificationPreferences.lastDigestAt,
      })
      .from(workspaceUsers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceUsers.workspaceId))
      .leftJoin(notificationPreferences, eq(notificationPreferences.workspaceUserId, workspaceUsers.id))
      .where(and(scope, acceptedMemberSql));

    // No saved row means the defaults, a daily digest (what Settings shows).
    const byWorkspace = new Map<string, Array<(typeof members)[number] & NonNullable<ReturnType<typeof digestWindow>>>>();
    for (const m of members) {
      const w = digestWindow(m.frequency ?? "daily", m.lastDigestAt, now);
      if (w) byWorkspace.set(m.workspaceId, [...(byWorkspace.get(m.workspaceId) ?? []), { ...m, ...w }]);
    }

    const origin = originFromHeaders(new Headers());
    const at = new Date(now);
    const counts = { due: 0, sent: 0, empty: 0, unsent: 0 };
    for (const [workspaceId, group] of byWorkspace) {
      counts.due += group.length;
      try {
        const data = await loadDigestData(workspaceId, new Date(Math.min(...group.map(m => m.since.getTime()))), now);
        for (const m of group) {
          const sections = digestSections(data, m, origin);
          if (sections.length === 0) {
            await markDigested(m, at);
            counts.empty++;
            continue;
          }
          // ponytail: one at a time, paced with every other send by lib/email
          // (2 a second by default, Resend's limit: about 7,000 digests an
          // hour). Use the provider's batch API if a deployment outgrows that.
          const waiting = data.waiting.length;
          const sent = await sendDigest({
            to: m.email,
            workspaceName: m.workspaceName,
            subject: waiting > 0
              ? `${waiting} ${waiting === 1 ? "loop" : "loops"} waiting on your team · ${m.workspaceName}`
              : `Your ${m.cadence} digest · ${m.workspaceName}`,
            heading: `Your ${m.cadence} digest`,
            sections,
            inboxUrl: origin ? `${origin}/inbox` : null,
            footer: `You get this ${DIGEST[m.cadence].every} as a member of ${m.workspaceName}. Change it in Crumb's Notifications settings.`,
          }).catch(() => false);
          if (sent) {
            await markDigested(m, at);
            counts.sent++;
          } else {
            counts.unsent++;
          }
        }
      } catch (err) {
        log.error("digest failed for a workspace", { scope: "crumb/digest", workspaceId, err });
      }
    }
    log.info("digest run", { scope: "crumb/digest", ...counts });
    return counts;
  } finally {
    digestRunning = false;
  }
}
