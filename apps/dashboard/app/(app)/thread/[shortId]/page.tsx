import { Suspense } from "react";
import { and, eq } from "drizzle-orm";
import { db, items } from "@crumb/db";
import { getSession } from "@/lib/auth";
import { ThreadViewTile } from "./ThreadViewTile";
import { ThreadSkeleton } from "./ThreadSkeleton";

export const dynamic = "force-dynamic";

// "FB-12 · Export to CSV": one lookup on the (workspace, short id) unique index.
// The short id is free text from the URL, so a failed lookup falls back to a
// plain title instead of throwing; the page decides what to render.
export async function generateMetadata({ params }: { params: { shortId: string } }) {
  const session = await getSession();
  if (!session) return {}; // the layout is about to redirect to /login
  const [item] = await db
    .select({ title: items.title })
    .from(items)
    .where(and(eq(items.workspaceId, session.workspace.id), eq(items.shortId, params.shortId)))
    .limit(1)
    .catch(() => []);
  return { title: item ? `${params.shortId} · ${item.title}` : "Not found" };
}

export default function ThreadPage({ params }: { params: { shortId: string } }) {
  return (
    <Suspense fallback={<ThreadSkeleton shortId={params.shortId} />}>
      <ThreadViewTile shortId={params.shortId} />
    </Suspense>
  );
}
