import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, workspaceUsers, notificationPreferences, items, accounts, workspaces } from "@crumb/db";
import { sendCustomerReplyNotification } from "./email";
import { resolveSlackUserId, sendDirectMessage, buildCustomerReplyBlocks } from "./slack/notify";
import { openNullable } from "./crypto-at-rest";
import { clearProviderInstall, isSlackRevokedError } from "./integrations/revoke";
import { notifyWorkspaceChannel } from "./notify/chat";
import { originFromHeaders } from "./origin";
import { log } from "./log";

// When a customer replies (via widget POST or inbound webhook), nudge the
// vendor team. Recipients:
//   - the item's assignee if set
//   - otherwise all admins on the workspace
// Each recipient is then filtered by their notification_preferences:
//   - replyRealtime must be true (default true)
//   - delivery picks the channel: "email" (default), "slack", or "none"
//
// Slack delivery falls back to email when Slack isn't installed, the
// user_id lookup fails, or the DM send errors — better to over-deliver
// than to silently drop a customer reply.
//
// No-op when there are no recipients after filtering. All failures swallowed
// — caller already wrote the reply row; notifications are best-effort.

export async function notifyVendorsOfCustomerReply(opts: {
  itemId: string;
  customerName: string;
  replyBody: string;
  dashboardOrigin: string | null;  // e.g. "https://dashboard.example.com" — for the View thread link
}): Promise<void> {
  // Hydrate item + workspace + account context in one join. Pulls the
  // slack bot token too so we can DM without a second round-trip.
  const [ctx] = await db
    .select({
      itemId: items.id,
      shortId: items.shortId,
      title: items.title,
      assigneeId: items.assigneeId,
      workspaceId: items.workspaceId,
      workspaceName: workspaces.name,
      accountName: accounts.name,
      slackBotToken: workspaces.slackBotToken,
    })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .innerJoin(workspaces, eq(workspaces.id, items.workspaceId))
    .where(eq(items.id, opts.itemId))
    .limit(1);
  if (!ctx) return;
  // Decrypt the bot token once. A malformed/un-decryptable token (e.g. a key
  // rotated away) must not sink the whole notification — treat it as "no
  // Slack" so we still fall through to email.
  try {
    ctx.slackBotToken = openNullable(ctx.slackBotToken);
  } catch {
    ctx.slackBotToken = null;
  }

  // Vendor Teams firehose — post the customer reply to the workspace channel
  // (if connected), independent of the per-recipient DM/email below.
  void notifyWorkspaceChannel(ctx.workspaceId, {
    kind: "customer_reply",
    shortId: ctx.shortId,
    title: ctx.title,
    accountName: ctx.accountName,
    customerName: opts.customerName,
    body: opts.replyBody,
    url: opts.dashboardOrigin ? `${opts.dashboardOrigin}/thread/${ctx.shortId}` : null,
  });

  // Pick recipient pool: assignee, or all admins. Pull slack fields so
  // we can route DMs without another query.
  const pool = ctx.assigneeId
    ? await db
        .select({
          id: workspaceUsers.id,
          email: workspaceUsers.email,
          name: workspaceUsers.name,
          slackUserId: workspaceUsers.slackUserId,
          slackLookupFailedAt: workspaceUsers.slackLookupFailedAt,
        })
        .from(workspaceUsers)
        .where(eq(workspaceUsers.id, ctx.assigneeId))
    : await db
        .select({
          id: workspaceUsers.id,
          email: workspaceUsers.email,
          name: workspaceUsers.name,
          slackUserId: workspaceUsers.slackUserId,
          slackLookupFailedAt: workspaceUsers.slackLookupFailedAt,
        })
        .from(workspaceUsers)
        .where(and(eq(workspaceUsers.workspaceId, ctx.workspaceId), eq(workspaceUsers.role, "admin")));

  if (pool.length === 0) return;

  // Filter by preferences. Missing row ⇒ defaults (replyRealtime true, delivery email).
  const prefs = await db
    .select()
    .from(notificationPreferences)
    .where(inArray(notificationPreferences.workspaceUserId, pool.map(p => p.id)));
  const prefByUser = new Map(prefs.map(p => [p.workspaceUserId, p]));

  type Channel = "email" | "slack";
  type Recipient = (typeof pool)[number] & { channel: Channel };
  const recipients: Recipient[] = [];
  for (const u of pool) {
    const pref = prefByUser.get(u.id);
    if (pref && !pref.replyRealtime) continue;
    if (pref && pref.delivery === "none") continue;
    // Default delivery is email. Slack requires the workspace install.
    const wantSlack = !!(pref && pref.delivery === "slack" && ctx.slackBotToken);
    recipients.push({ ...u, channel: wantSlack ? "slack" : "email" });
  }

  if (recipients.length === 0) return;

  const dashboardThreadUrl = opts.dashboardOrigin
    ? `${opts.dashboardOrigin}/thread/${ctx.shortId}`
    : null;

  await Promise.all(recipients.map(r => dispatchOne(r, ctx, opts, dashboardThreadUrl)));
}

async function dispatchOne(
  r: {
    id: string;
    email: string;
    name: string;
    slackUserId: string | null;
    slackLookupFailedAt: Date | null;
    channel: "email" | "slack";
  },
  ctx: {
    workspaceId: string;
    shortId: string;
    title: string;
    workspaceName: string;
    accountName: string;
    slackBotToken: string | null;
  },
  opts: { customerName: string; replyBody: string },
  dashboardThreadUrl: string | null,
): Promise<void> {
  if (r.channel === "slack" && ctx.slackBotToken) {
    const slackUserId = await resolveSlackUserId({
      botToken: ctx.slackBotToken,
      workspaceUserId: r.id,
      email: r.email,
      lastFailedAt: r.slackLookupFailedAt,
      cachedUserId: r.slackUserId,
    });
    if (slackUserId) {
      const msg = buildCustomerReplyBlocks({
        customerName: opts.customerName,
        accountName: ctx.accountName,
        itemShortId: ctx.shortId,
        itemTitle: ctx.title,
        replyBody: opts.replyBody,
        dashboardThreadUrl,
      });
      const sent = await sendDirectMessage({
        botToken: ctx.slackBotToken,
        slackUserId,
        text: msg.text,
        blocks: msg.blocks,
      });
      if (sent.ok) return;
      // A revoked/uninstalled Slack app reports token_revoked / account_inactive
      // etc. — clear the install so the workspace stops trying and the UI shows
      // disconnected. Best-effort; we still fall back to email below.
      if (isSlackRevokedError(sent.error)) {
        await clearProviderInstall(ctx.workspaceId, "slack").catch(() => {});
      }
      log.warn("slack DM failed; falling back to email", { scope: "crumb/slack", email: r.email, error: sent.error });
    }
    // Fall through to email if Slack lookup or send didn't work.
  }

  await sendCustomerReplyNotification({
    to: r.email,
    workspaceName: ctx.workspaceName,
    customerName: opts.customerName,
    accountName: ctx.accountName,
    itemShortId: ctx.shortId,
    itemTitle: ctx.title,
    replyBody: opts.replyBody,
    dashboardThreadUrl,
  }).catch(err => {
    log.error("customer-reply notify failed", { scope: "crumb/customer-reply", email: r.email, err });
  });
}

// Build "https://host" from a Request, used to construct the dashboard thread
// URL inside the email. Thin wrapper over the shared helper.
export function dashboardOriginFromHeaders(req: Request): string | null {
  return originFromHeaders(req.headers);
}
