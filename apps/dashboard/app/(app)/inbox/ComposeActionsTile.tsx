import { asc, eq } from "drizzle-orm";
import { db, accounts } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { ComposePanel } from "./ComposePanel";

// Compose is for admins and PMs (composeOnBehalf refuses viewers too).
export async function ComposeActionsTile() {
  const { workspace: ws, user } = await getActiveSession();
  if (user.role !== "admin" && user.role !== "pm") return null;
  const rows = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.workspaceId, ws.id))
    .orderBy(asc(accounts.name));
  return <ComposePanel knownAccounts={rows.map(r => r.name)} />;
}
