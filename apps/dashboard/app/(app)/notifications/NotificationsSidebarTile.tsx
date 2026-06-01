import Link from "next/link";
import { Btn, Card, CardHead, StatusDot } from "@crumb/ui";
import { db, items, accounts, accountUsers, notificationPreferences, replies } from "@crumb/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { isCloud } from "@/lib/tier";
import { PreferencesCard, type PrefsState } from "./PreferencesCard";

const DEFAULT_PREFS: PrefsState = {
  digestFrequency: "daily",
  newSubmissionRealtime: true,
  replyRealtime: true,
  mentionRealtime: true,
  statusChangeRealtime: false,
  clusterSuggestionsRealtime: false,
  delivery: "email",
};

async function loadPreferences(workspaceUserId: string): Promise<PrefsState> {
  const [row] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.workspaceUserId, workspaceUserId))
    .limit(1);
  if (!row) return DEFAULT_PREFS;
  return {
    digestFrequency: (row.digestFrequency as PrefsState["digestFrequency"]),
    newSubmissionRealtime: row.newSubmissionRealtime,
    replyRealtime: row.replyRealtime,
    mentionRealtime: row.mentionRealtime,
    statusChangeRealtime: row.statusChangeRealtime,
    clusterSuggestionsRealtime: row.clusterSuggestionsRealtime,
    delivery: (row.delivery as PrefsState["delivery"]),
  };
}

// "Last 24 hours" preview for the digest card. Scoped to recent items +
// recent customer replies so we get the same "what's about to be in
// tomorrow's email" shape without re-querying the full feed.
async function loadLastDay(workspaceId: string) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const recentItems = await db
    .select({
      what: sql<string>`'New:'`,
      item: items.title,
      whoSub: accounts.name,
      at: items.createdAt,
    })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .where(and(eq(items.workspaceId, workspaceId), gt(items.createdAt, since)))
    .orderBy(desc(items.createdAt))
    .limit(8);

  const recentReplies = await db
    .select({
      what: sql<string>`'Reply:'`,
      item: items.title,
      whoSub: accounts.name,
      at: replies.createdAt,
    })
    .from(replies)
    .innerJoin(items, eq(items.id, replies.itemId))
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .leftJoin(accountUsers, eq(accountUsers.id, replies.accountUserId))
    .where(and(eq(items.workspaceId, workspaceId), gt(replies.createdAt, since), eq(replies.internal, false)))
    .orderBy(desc(replies.createdAt))
    .limit(8);

  const all = [...recentItems, ...recentReplies].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 8);
  const accountsTouched = new Set(all.map(e => e.whoSub)).size;
  return { entries: all, accountsTouched };
}

export async function NotificationsSidebarTile() {
  const { workspace, user } = await getActiveSession();
  const [prefs, lastDay] = await Promise.all([
    loadPreferences(user.id),
    loadLastDay(workspace.id),
  ]);

  const digestLine = lastDay.entries.length === 0
    ? "Today's trail: nothing new. Quiet day."
    : `Today's trail: ${lastDay.entries.length} ${lastDay.entries.length === 1 ? "event" : "events"} across ${lastDay.accountsTouched} ${lastDay.accountsTouched === 1 ? "account" : "accounts"}.`;

  return (
    <div className="col gap-4">
      <PreferencesCard initial={prefs} isCloud={isCloud()} slackInstalled={!!workspace.slackBotToken} />

      <Card>
        <CardHead title="Digest preview · tomorrow 9am" />
        <div className="card-body col gap-3">
          <div className="text-xs muted mono">from noreply@crumb.localhostlabs.net</div>
          <div className="display" style={{ fontSize: 22, lineHeight: 1.25 }}>{digestLine}</div>
          {lastDay.entries.length > 0 && (
            <div className="col gap-2 text-sm">
              {lastDay.entries.slice(0, 4).map((e, i) => (
                <div key={i} className="row gap-3 center">
                  <StatusDot status="open" />
                  <span className="grow truncate">{e.what} {e.item}</span>
                  <span className="muted">{e.whoSub}</span>
                </div>
              ))}
            </div>
          )}
          <Link href="/inbox" style={{ alignSelf: "flex-start" }}>
            <Btn sm>Open inbox →</Btn>
          </Link>
        </div>
      </Card>
    </div>
  );
}
