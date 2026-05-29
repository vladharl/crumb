import "server-only";
import { eq } from "drizzle-orm";
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

// Single DM with text + a context line. Slack's Block Kit gives us a
// title link + body; keep it tight so the unfurl is a single nudge.
export async function sendDirectMessage(opts: {
  botToken: string;
  slackUserId: string;
  text: string;
  blocks?: SlackBlock[];
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: opts.slackUserId,
        text: opts.text,
        blocks: opts.blocks,
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
function escapeSlackText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function blockQuote(body: string): string {
  return body.split("\n").map(line => `> ${escapeSlackText(line)}`).join("\n");
}
