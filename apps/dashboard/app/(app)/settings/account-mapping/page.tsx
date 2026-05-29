import { Btn, Card, CardHead, Ic, Pill } from "@crumb/ui";
import { db, accounts, accountUsers } from "@crumb/db";
import { asc, eq, sql } from "drizzle-orm";
import { getActiveWorkspace } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function AccountMappingPage() {
  const ws = await getActiveWorkspace();
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      users: sql<number>`(
        SELECT COUNT(*)::int FROM ${accountUsers}
        WHERE ${accountUsers.accountId} = ${accounts.id}
      )`,
    })
    .from(accounts)
    .where(eq(accounts.workspaceId, ws.id))
    .orderBy(asc(accounts.name));

  return (
    <Card>
      <CardHead
        title="Account mapping"
        after={<Pill>{rows.length} {rows.length === 1 ? "account" : "accounts"}</Pill>}
      />
      <div className="card-body col gap-3">
        <p className="text-sm muted" style={{ margin: 0, maxWidth: "62ch" }}>
          Each account collects one or many users. Domain-based auto-mapping is a future turn; for now accounts and users come in through the widget submission flow.
        </p>
        <div style={{ border: "var(--border)", borderRadius: "var(--r-sm)", overflow: "hidden" }}>
          {rows.length === 0 && (
            <div style={{ padding: 18 }}>
              <p className="text-sm muted" style={{ margin: 0 }}>
                No accounts yet — submit something via the widget at <span className="mono">/widget-demo.html</span>.
              </p>
            </div>
          )}
          {rows.map((row, i, arr) => (
            <div
              key={row.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 70px 22px",
                alignItems: "center",
                gap: 14,
                padding: "12px 18px",
                borderBottom: i < arr.length - 1 ? "var(--border)" : 0,
              }}
            >
              <span className="serif text-md">{row.name}</span>
              <span className="text-xs muted">{row.users} {row.users === 1 ? "user" : "users"}</span>
              <Ic.more style={{ width: 13, height: 13, color: "var(--mute-2)" }} />
            </div>
          ))}
        </div>
        <div className="row gap-2">
          <Btn sm icon={<Ic.plus style={{ width: 11, height: 11 }} />}>Add account</Btn>
          <Btn sm variant="ghost">Override user</Btn>
          <Btn sm variant="ghost">Import from CSV</Btn>
        </div>
      </div>
    </Card>
  );
}
