import { Card, CardHead, Pill } from "@crumb/ui";
import { db, accounts, accountUsers } from "@crumb/db";
import { asc, eq } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { AccountMappingPanel, type AccountView } from "./AccountMappingPanel";

export const dynamic = "force-dynamic";

export default async function AccountMappingPage() {
  const { workspace: ws, user } = await getActiveSession();

  const accountRows = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.workspaceId, ws.id))
    .orderBy(asc(accounts.name));

  const userRows = await db
    .select({ id: accountUsers.id, accountId: accountUsers.accountId, email: accountUsers.email, name: accountUsers.name })
    .from(accountUsers)
    .where(eq(accountUsers.workspaceId, ws.id))
    .orderBy(asc(accountUsers.email));

  const usersByAccount = new Map<string, AccountView["users"]>();
  for (const u of userRows) {
    const arr = usersByAccount.get(u.accountId) ?? [];
    arr.push({ id: u.id, email: u.email, name: u.name });
    usersByAccount.set(u.accountId, arr);
  }
  const initial: AccountView[] = accountRows.map(a => ({ id: a.id, name: a.name, users: usersByAccount.get(a.id) ?? [] }));

  return (
    <Card>
      <CardHead
        title="Account mapping"
        after={<Pill>{initial.length} {initial.length === 1 ? "account" : "accounts"}</Pill>}
      />
      <div className="card-body col gap-4">
        <p className="text-sm muted" style={{ margin: 0, maxWidth: "62ch" }}>
          Each account collects one or many users. Accounts arrive automatically through the widget; here you can add, rename, merge users across accounts, and bulk import/export via CSV (<span className="mono">account_name,email,name</span>).
        </p>
        <AccountMappingPanel initial={initial} isManager={user.role === "admin" || user.role === "pm"} />
      </div>
    </Card>
  );
}
