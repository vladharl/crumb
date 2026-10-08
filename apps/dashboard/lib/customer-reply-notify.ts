import "server-only";
import { eq } from "drizzle-orm";
import { db, workspaceUsers, items, accounts } from "@crumb/db";
import { sendCustomerReplyNotification } from "./email";
import { buildCustomerReplyBlocks } from "./slack/notify";
import { notifyWorkspaceChannel } from "./notify/chat";
import { nudge } from "./vendor-notify";
import { originFromHeaders } from "./origin";

// When a customer replies (via widget POST or inbound webhook), nudge the
// vendor team: the item's assignee, or the workspace admins when it's
// unassigned or the assignee won't get it (reply nudges off, delivery none,
// no longer a member), so a customer reply never reaches nobody. Each
// recipient's replyRealtime + delivery (email, Slack DM with email fallback)
// is applied by the shared dispatcher in lib/vendor-notify.ts.
//
// Best-effort: the caller already wrote the reply row.

export async function notifyVendorsOfCustomerReply(opts: {
  itemId: string;
  customerName: string;
  replyBody: string;
  dashboardOrigin: string | null;  // e.g. "https://dashboard.example.com" — for the View thread link
}): Promise<void> {
  const [ctx] = await db
    .select({
      shortId: items.shortId,
      title: items.title,
      assigneeId: items.assigneeId,
      workspaceId: items.workspaceId,
      accountName: accounts.name,
    })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .where(eq(items.id, opts.itemId))
    .limit(1);
  if (!ctx) return;

  const dashboardThreadUrl = opts.dashboardOrigin
    ? `${opts.dashboardOrigin}/thread/${ctx.shortId}`
    : null;

  // Vendor Teams firehose — post the customer reply to the workspace channel
  // (if connected), independent of the per-recipient DM/email below.
  void notifyWorkspaceChannel(ctx.workspaceId, {
    kind: "customer_reply",
    shortId: ctx.shortId,
    title: ctx.title,
    accountName: ctx.accountName,
    customerName: opts.customerName,
    body: opts.replyBody,
    url: dashboardThreadUrl,
  });

  const admins = eq(workspaceUsers.role, "admin");
  await nudge({
    workspaceId: ctx.workspaceId,
    pref: "replyRealtime",
    pools: ctx.assigneeId ? [eq(workspaceUsers.id, ctx.assigneeId), admins] : [admins],
    slack: buildCustomerReplyBlocks({
      customerName: opts.customerName,
      accountName: ctx.accountName,
      itemShortId: ctx.shortId,
      itemTitle: ctx.title,
      replyBody: opts.replyBody,
      dashboardThreadUrl,
    }),
    email: (to, workspaceName) => sendCustomerReplyNotification({
      to,
      workspaceName,
      customerName: opts.customerName,
      accountName: ctx.accountName,
      itemShortId: ctx.shortId,
      itemTitle: ctx.title,
      replyBody: opts.replyBody,
      dashboardThreadUrl,
    }),
  });
}

// Build "https://host" from a Request, used to construct the dashboard thread
// URL inside the email. Thin wrapper over the shared helper.
export function dashboardOriginFromHeaders(req: Request): string | null {
  return originFromHeaders(req.headers);
}
