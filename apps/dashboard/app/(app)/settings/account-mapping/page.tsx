import { Card, CardHead, Pill } from "@crumb/ui";
import { db, accounts, accountUsers } from "@crumb/db";
import { asc, eq } from "drizzle-orm";
import { getActiveSession } from "@/lib/server";
import { AccountMappingPanel, type AccountView } from "./AccountMappingPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account mapping · Settings" };

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
          Each account groups the people from one company. Accounts arrive on their own through the widget. Here you can add, rename or delete accounts, move people between them, and import or export a CSV (<span className="mono">account_name,email,name</span>). ARR comes from your CRM (connect one in Integrations) or is set on each account&apos;s page.
        </p>
        <AccountMappingPanel initial={initial} isManager={user.role === "admin" || user.role === "pm"} />
      </div>
    </Card>
  );
}
