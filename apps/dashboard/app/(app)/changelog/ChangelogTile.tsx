import { getActiveSession } from "@/lib/server";
import { announcementAudience, listChangelogEntries } from "@/lib/changelog";
import { ChangelogList } from "./ChangelogList";

// Server tile: load every entry (drafts + published) for the team view, and for
// an initiative's draft who publishing it would email (editors only).
export async function ChangelogTile() {
  const { workspace, user } = await getActiveSession();
  const canManage = user.role === "admin" || user.role === "pm";
  const entries = await listChangelogEntries(workspace.id);
  const audiences = new Map(canManage
    ? await Promise.all(entries
      .filter(e => !e.publishedAt && e.initiativeId)
      .map(async e => [e.id, await announcementAudience(workspace.id, e.initiativeId!)] as const))
    : []);
  return (
    <ChangelogList
      canManage={canManage}
      entries={entries.map((e) => ({
        id: e.id,
        title: e.title,
        body: e.body,
        isPublic: e.isPublic,
        publishedAt: e.publishedAt ? e.publishedAt.toISOString() : null,
        audience: audiences.get(e.id) ?? null,
      }))}
    />
  );
}
