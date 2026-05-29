import { asc, eq } from "drizzle-orm";
import { db, accounts } from "@crumb/db";
import { getActiveWorkspace } from "@/lib/server";
import { ComposePanel } from "./ComposePanel";

export async function ComposeActionsTile() {
  const ws = await getActiveWorkspace();
  const rows = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.workspaceId, ws.id))
    .orderBy(asc(accounts.name));
  return <ComposePanel knownAccounts={rows.map(r => r.name)} />;
}
