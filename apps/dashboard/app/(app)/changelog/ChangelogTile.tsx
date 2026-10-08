import { getActiveSession } from "@/lib/server";
import { announcementAudience, listChangelogEntries, type Audience, type ChangelogListEntry } from "@/lib/changelog";
import { ChangelogList } from "./ChangelogList";

// Server tile: load every entry (drafts + published) for the team view, and for
// each draft who publishing it would email (editors only).
export async function ChangelogTile() {
  const { workspace, user } = await getActiveSession();
  const canManage = user.role === "admin" || user.role === "pm";
  const entries = await listChangelogEntries(workspace.id);
  const audiences = new Map(canManage
    ? await Promise.all(entries
      .filter(e => !e.publishedAt)
      .map(async e => [e.id, await announcementAudience(workspace.id, e.initiativeId)] as const))
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
        audience: draftAudience(e, audiences.get(e.id)),
      }))}
    />
  );
}

// Public followers only get public entries, and a hand-written draft that
// emails no one just publishes.
function draftAudience(e: ChangelogListEntry, a: Audience | undefined): Audience | null {
  if (!a) return null;
  const audience = e.isPublic ? a : { ...a, followers: 0 };
  return e.initiativeId || audience.followers > 0 ? audience : null;
}
