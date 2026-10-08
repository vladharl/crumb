import "server-only";
import { inArray } from "drizzle-orm";
import { workspaceUsers } from "@crumb/db";
import { sendMentionNotification } from "./email";
import { escapeSlackText } from "./slack/notify";
import { nudge } from "./vendor-notify";

// Notify teammates @-mentioned in an internal note. Each recipient's
// mentionRealtime + delivery (email, Slack DM with email fallback) is applied
// by the shared dispatcher in lib/vendor-notify.ts. Best-effort — never blocks
// the note write. Callers must exclude the author from mentionedUserIds.
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
  const threadUrl = opts.dashboardOrigin ? `${opts.dashboardOrigin}/thread/${opts.itemShortId}` : null;
  await nudge({
    workspaceId: opts.workspaceId,
    pref: "mentionRealtime",
    pools: [inArray(workspaceUsers.id, opts.mentionedUserIds)],
    // The title is customer-written; escaped so `<url|label>` stays text.
    slack: {
      text: `*${escapeSlackText(opts.byName)}* mentioned you on _${escapeSlackText(opts.itemTitle)}_ (${opts.itemShortId})`
        + (threadUrl ? `\n<${threadUrl}|Open thread →>` : ""),
    },
    email: (to, workspaceName) => sendMentionNotification({
      to,
      workspaceName,
      byName: opts.byName,
      itemShortId: opts.itemShortId,
      itemTitle: opts.itemTitle,
      noteBody: opts.noteBody,
      dashboardThreadUrl: threadUrl,
    }),
  });
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
