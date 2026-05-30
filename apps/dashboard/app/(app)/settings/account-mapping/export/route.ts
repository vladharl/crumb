import { asc, eq } from "drizzle-orm";
import { db, accounts, accountUsers } from "@crumb/db";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// CSV-escape a field: quote when it contains a comma, quote, or newline.
function csv(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Authenticated download of accounts × users as CSV. The import flow accepts
// this exact shape back.
export async function GET() {
  const { workspace } = await requireSession();

  const rows = await db
    .select({
      account: accounts.name,
      email: accountUsers.email,
      name: accountUsers.name,
    })
    .from(accounts)
    .leftJoin(accountUsers, eq(accountUsers.accountId, accounts.id))
    .where(eq(accounts.workspaceId, workspace.id))
    .orderBy(asc(accounts.name), asc(accountUsers.email));

  const lines = ["account_name,email,name"];
  for (const r of rows) {
    lines.push([csv(r.account), csv(r.email ?? ""), csv(r.name ?? "")].join(","));
  }
  const body = lines.join("\n") + "\n";

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${workspace.slug}-accounts.csv"`,
    },
  });
}
