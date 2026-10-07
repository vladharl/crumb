import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, items, workspaces, replies, workspaceUsers, accountUsers, attachments } from "@crumb/db";
import { pickReplyTarget, signReplyToken } from "@/lib/reply-token";
import { signedAttachmentPath } from "@/lib/attachments/signed-url";

// The hosted, read-only copy of one feedback thread (app/t/[shortId]/[token]),
// where customer emails link when the workspace has no Product URL to open the
// widget on. No login: the token in the path is the capability. It's the
// reply-token HMAC over "view:<shortId>", so a view link never verifies as a
// reply address (which can post to the thread) and a reply address never opens
// the page. Rotating the workspace signing secret kills both.

const viewPayload = (shortId: string) => `view:${shortId}`;

// Path only; the caller prefixes the public origin.
export function hostedThreadPath(shortId: string, signingSecret: string): string {
  return `/t/${shortId}/${signReplyToken(viewPayload(shortId), signingSecret)}`;
}

// The item a link names, with only what its customer may see: no internal
// notes, no account, ARR or assignee. Null for a forged or stale token.
export async function loadHostedThread(shortId: string, token: string) {
  // ponytail: one row per workspace that has reached this FB number, each
  // HMAC-checked, as the inbound reply route does. Cheap at today's scale.
  const candidates = await db
    .select({
      id: items.id,
      title: items.title,
      body: items.body,
      status: items.status,
      createdAt: items.createdAt,
      workspaceName: workspaces.name,
      accent: workspaces.accent,
      signingSecret: workspaces.signingSecret,
    })
    .from(items)
    .innerJoin(workspaces, eq(workspaces.id, items.workspaceId))
    .where(eq(items.shortId, shortId));
  const match = pickReplyTarget(viewPayload(shortId), token, candidates);
  if (!match) return null;
  const { signingSecret, ...item } = match;

  const messages = await db
    .select({
      id: replies.id,
      body: replies.body,
      createdAt: replies.createdAt,
      vendorName: workspaceUsers.name,
      customerName: accountUsers.name,
    })
    .from(replies)
    .leftJoin(workspaceUsers, eq(workspaceUsers.id, replies.workspaceUserId))
    .leftJoin(accountUsers, eq(accountUsers.id, replies.accountUserId))
    .where(and(eq(replies.itemId, item.id), eq(replies.internal, false)))
    .orderBy(asc(replies.createdAt));

  const files = messages.length === 0 ? [] : await db
    .select({ id: attachments.id, replyId: attachments.replyId, filename: attachments.filename })
    .from(attachments)
    .where(inArray(attachments.replyId, messages.map(m => m.id)));

  return {
    item,
    messages: messages.map(m => ({
      id: m.id,
      body: m.body,
      createdAt: m.createdAt,
      author: m.vendorName ?? m.customerName,
      fromVendor: m.vendorName != null,
      // Same-origin signed links, minted per view (they expire in an hour).
      files: files
        .filter(f => f.replyId === m.id)
        .map(f => ({ name: f.filename, href: signedAttachmentPath(f.id, signingSecret) })),
    })),
  };
}
