import { redirect } from "next/navigation";
import { db, items } from "@crumb/db";
import { desc, eq } from "drizzle-orm";
import { getActiveWorkspace } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function ThreadIndex() {
  const ws = await getActiveWorkspace();
  const [latest] = await db
    .select({ shortId: items.shortId })
    .from(items)
    .where(eq(items.workspaceId, ws.id))
    .orderBy(desc(items.createdAt))
    .limit(1);

  if (!latest) redirect("/inbox");
  redirect(`/thread/${latest.shortId}`);
}
