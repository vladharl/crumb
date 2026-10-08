import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, workspaceUsers } from "@crumb/db";

// Slack Web API "users.lookupByEmail" — returns a user_id we can DM via
// im.write + chat.postMessage. Cached on workspace_users so the lookup
// runs once per (workspace, user).
export async function resolveSlackUserId(opts: {
  botToken: string;
  workspaceUserId: string;
  email: string;
  // The most recent failed lookup at; if recent, skip retrying.
  lastFailedAt: Date | null;
  cachedUserId: string | null;
}): Promise<string | null> {
  if (opts.cachedUserId) return opts.cachedUserId;
  // Skip retry if we failed in the last 24h. The workspace_users row gets
  // cleared by a successful manual link from settings — out of v1 scope;
  // a re-install of Slack clears the timestamp implicitly via /set null/.
  if (opts.lastFailedAt && Date.now() - opts.lastFailedAt.getTime() < 24 * 60 * 60 * 1000) {
    return null;
  }

  try {
    const params = new URLSearchParams({ email: opts.email });
    const resp = await fetch(`https://slack.com/api/users.lookupByEmail?${params.toString()}`, {
      headers: { authorization: `Bearer ${opts.botToken}` },
    });
    const data = await resp.json();
    if (!data.ok || !data.user?.id) {
      await db
        .update(workspaceUsers)
        .set({ slackLookupFailedAt: new Date() })
        .where(eq(workspaceUsers.id, opts.workspaceUserId));
      return null;
    }
    const slackUserId: string = data.user.id;
    await db
      .update(workspaceUsers)
      .set({ slackUserId, slackLookupFailedAt: null })
      .where(eq(workspaceUsers.id, opts.workspaceUserId));
    return slackUserId;
  } catch {
    return null;
  }
}

// Single Slack message with text + a context line. `slackUserId` is any
// conversation id — a DM user id OR a channel id. Pass `threadTs` to reply in a
// thread (the Phase-0 sizing bot replies under the @mention). `ephemeralTo`
// posts it in the channel visible to that user only (chat.postEphemeral).
export async function sendDirectMessage(opts: {
  botToken: string;
  slackUserId: string;
  text: string;
  blocks?: SlackBlock[];
  threadTs?: string;
  ephemeralTo?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(`https://slack.com/api/${opts.ephemeralTo ? "chat.postEphemeral" : "chat.postMessage"}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: opts.slackUserId,
        user: opts.ephemeralTo,
        text: opts.text,
        blocks: opts.blocks,
        thread_ts: opts.threadTs,
        // Suppress link unfurling — the dashboard link inside the message
        // expands to a giant unfurl card otherwise.
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const data = await resp.json();
    if (!data.ok) return { ok: false, error: data.error ?? "unknown" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "send_failed" };
  }
}

// Slack "users.info" → the member's email. Used by the Phase-0 sizing bot to
// map the person who @mentioned us to a customer account. Needs users:read +
// users:read.email. Returns null on any failure or an email-less profile
// (enterprise-restricted) — callers degrade gracefully.
export async function getSlackUserEmail(botToken: string, slackUserId: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ user: slackUserId });
    const resp = await fetch(`https://slack.com/api/users.info?${params.toString()}`, {
      headers: { authorization: `Bearer ${botToken}` },
    });
    const data = await resp.json();
    const email = data?.user?.profile?.email;
    return typeof email === "string" && email ? email : null;
  } catch {
    return null;
  }
}

// The Crumb teammate behind a Slack user, or null: the sizing bot and /crumb
// show requester ARR, other accounts' requests and the customer list. They
// must belong to the installing Slack team (a Slack Connect channel holds other
// organizations' users) and match a teammate of this workspace by their Slack
// email (which a guest's won't). Their Slack id is cached on the match, as a DM
// lookup would, so the next DM skips users.lookupByEmail.
export async function slackTeammate(opts: {
  workspaceId: string;
  installTeamId: string;
  botToken: string;
  slackUserId: string | undefined;
  userTeamId: string | undefined;
}): Promise<{ id: string; email: string } | null> {
  if (!opts.slackUserId || opts.userTeamId !== opts.installTeamId) return null;
  const email = await getSlackUserEmail(opts.botToken, opts.slackUserId);
  if (!email) return null;
  const [member] = await db
    .select({ id: workspaceUsers.id, slackUserId: workspaceUsers.slackUserId })
    .from(workspaceUsers)
    .where(and(eq(workspaceUsers.workspaceId, opts.workspaceId), sql`lower(${workspaceUsers.email}) = ${email.toLowerCase()}`))
    .limit(1);
  if (!member) return null;
  if (member.slackUserId !== opts.slackUserId) {
    await db
      .update(workspaceUsers)
      .set({ slackUserId: opts.slackUserId, slackLookupFailedAt: null })
      .where(eq(workspaceUsers.id, member.id));
  }
  return { id: member.id, email };
}

// ─── message composers (one per notification kind) ──────────

type SlackBlock = Record<string, unknown>;

export function buildCustomerReplyBlocks(opts: {
  customerName: string;
  accountName: string;
  itemShortId: string;
  itemTitle: string;
  replyBody: string;
  dashboardThreadUrl: string | null;
}): { text: string; blocks: SlackBlock[] } {
  const truncated = opts.replyBody.length > 280 ? opts.replyBody.slice(0, 280) + "…" : opts.replyBody;
  const text = `${opts.customerName} (${opts.accountName}) replied on ${opts.itemShortId}: ${truncated}`;

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeSlackText(opts.customerName)}* from *${escapeSlackText(opts.accountName)}* replied on _${escapeSlackText(opts.itemTitle)}_`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: blockQuote(truncated) },
    },
  ];

  if (opts.dashboardThreadUrl) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${opts.dashboardThreadUrl}|Open thread → ${opts.itemShortId}>`,
        },
      ],
    });
  }

  return { text, blocks };
}

// Slack mrkdwn escapes: just the three special chars. Keeping it simple
// since we never render user-controlled HTML — the customer name and
// item title flow through here.
export function escapeSlackText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function blockQuote(body: string): string {
  return body.split("\n").map(line => `> ${escapeSlackText(line)}`).join("\n");
}
