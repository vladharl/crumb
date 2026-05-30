import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, workspaces, workspaceUsers, notificationPreferences } from "@crumb/db";
import { sendMentionNotification } from "./email";
import { resolveSlackUserId, sendDirectMessage } from "./slack/notify";
import { openNullable } from "./crypto-at-rest";
import { clearProviderInstall, isSlackRevokedError } from "./integrations/revoke";
import { log } from "./log";

// Notify teammates @-mentioned in an internal note. Each recipient is filtered
// by their notification_preferences (mentionRealtime must be on; delivery picks
// Slack vs email, falling back to email). Best-effort — never blocks the note
// write. Callers must exclude the author from mentionedUserIds.
export async function notifyMentioned(opts: {
  workspaceId: string;
  itemShortId: string;
  itemTitle: string;
  noteBody: string;
  byName: string;
  mentionedUserIds: string[];
  dashboardOrigin: string | null;
}): Promise<void> {
  if (opts.mentionedUserIds.length === 0) return;
  try {
    const [ws] = await db
      .select({ name: workspaces.name, slackBotToken: workspaces.slackBotToken })
      .from(workspaces)
      .where(eq(workspaces.id, opts.workspaceId))
      .limit(1);
    if (!ws) return;

    let botToken: string | null = null;
    try { botToken = openNullable(ws.slackBotToken); } catch { botToken = null; }

    const users = await db
      .select({
        id: workspaceUsers.id,
        email: workspaceUsers.email,
        name: workspaceUsers.name,
        slackUserId: workspaceUsers.slackUserId,
        slackLookupFailedAt: workspaceUsers.slackLookupFailedAt,
      })
      .from(workspaceUsers)
      .where(and(eq(workspaceUsers.workspaceId, opts.workspaceId), inArray(workspaceUsers.id, opts.mentionedUserIds)));
    if (users.length === 0) return;

    const prefs = await db
      .select()
      .from(notificationPreferences)
      .where(inArray(notificationPreferences.workspaceUserId, users.map(u => u.id)));
    const prefByUser = new Map(prefs.map(p => [p.workspaceUserId, p]));

    const threadUrl = opts.dashboardOrigin ? `${opts.dashboardOrigin}/thread/${opts.itemShortId}` : null;

    await Promise.all(users.map(async (u) => {
      const pref = prefByUser.get(u.id);
      if (pref && !pref.mentionRealtime) return;       // mentions muted
      if (pref && pref.delivery === "none") return;

      if (pref && pref.delivery === "slack" && botToken) {
        const slackUserId = await resolveSlackUserId({
          botToken, workspaceUserId: u.id, email: u.email,
          lastFailedAt: u.slackLookupFailedAt, cachedUserId: u.slackUserId,
        });
        if (slackUserId) {
          const text = `*${opts.byName}* mentioned you on _${opts.itemTitle}_ (${opts.itemShortId})`
            + (threadUrl ? `\n<${threadUrl}|Open thread →>` : "");
          const sent = await sendDirectMessage({ botToken, slackUserId, text });
          if (sent.ok) return;
          if (isSlackRevokedError(sent.error)) {
            await clearProviderInstall(opts.workspaceId, "slack").catch(() => {});
          }
          // fall through to email
        }
      }

      await sendMentionNotification({
        to: u.email,
        workspaceName: ws.name,
        byName: opts.byName,
        itemShortId: opts.itemShortId,
        itemTitle: opts.itemTitle,
        noteBody: opts.noteBody,
        dashboardThreadUrl: threadUrl,
      }).catch(err => log.error("mention email failed", { scope: "crumb/mention", email: u.email, err }));
    }));
  } catch (err) {
    log.error("mention notify failed", { scope: "crumb/mention", err });
  }
}

// Parse @-mentions from a note body against the workspace's teammates. Matches
// `@Display Name` (longest names first so "@Lina Rivers" wins over "@Lina").
// Returns the matched workspace_user ids. Case-insensitive.
export function parseMentionIds(
  body: string,
  teammates: Array<{ id: string; name: string }>,
): string[] {
  const lower = body.toLowerCase();
  const matched = new Set<string>();
  // Longest names first to avoid a shorter name shadowing a longer one.
  const sorted = [...teammates].sort((a, b) => b.name.length - a.name.length);
  for (const t of sorted) {
    const needle = `@${t.name.toLowerCase()}`;
    if (lower.includes(needle)) matched.add(t.id);
  }
  return [...matched];
}
