import { getActiveSession } from "@/lib/server";
import { listChangelogEntries } from "@/lib/changelog";
import { ChangelogList } from "./ChangelogList";

// Server tile: load every entry (drafts + published) for the team view.
export async function ChangelogTile() {
  const { workspace, user } = await getActiveSession();
  const canManage = user.role === "admin" || user.role === "pm";
  const entries = await listChangelogEntries(workspace.id);
  return (
    <ChangelogList
      canManage={canManage}
      entries={entries.map((e) => ({
        id: e.id,
        title: e.title,
        body: e.body,
        isPublic: e.isPublic,
        publishedAt: e.publishedAt ? e.publishedAt.toISOString() : null,
      }))}
    />
  );
}
