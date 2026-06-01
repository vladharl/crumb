import { NextResponse } from "next/server";
import { ageFrom, getActiveSession } from "@/lib/server";
import { loadFeed } from "@/lib/notifications-feed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Backing endpoint for the top-bar notification bell. Session-authenticated
// (same cookie as the rest of the app). Returns the unread count + the most
// recent entries as a serializable DTO (Date → age string).
export async function GET() {
  const { workspace, user } = await getActiveSession();
  const feed = await loadFeed(workspace.id, user.id, user.notificationsLastReadAt ?? null);
  const unread = feed.filter(e => e.unread).length;
  const entries = feed.slice(0, 10).map(e => ({
    id: e.id,
    shortId: e.shortId,
    href: e.href,
    who: e.who,
    whoSub: e.whoSub,
    what: e.what,
    item: e.item,
    age: ageFrom(e.at),
    unread: e.unread,
    internal: e.internal,
    mentioned: e.mentioned,
  }));
  return NextResponse.json({ unread, entries });
}
