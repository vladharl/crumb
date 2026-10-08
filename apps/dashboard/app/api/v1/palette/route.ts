import { NextResponse } from "next/server";
import { and, asc, desc, eq, ilike, or, sql, type AnyColumn } from "drizzle-orm";
import { db, accounts, initiatives, items } from "@crumb/db";
import { statusLabel } from "@crumb/ui";
import { getSession } from "@/lib/auth";
import { splitTerms } from "@/lib/fuzzy";
import { likeContains } from "@/lib/like";
import { formatArr } from "@/lib/priority";
import type { PaletteResponse } from "@/components/CommandPalette";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PER_GROUP = 5;

// Search behind the ⌘K palette: feedback by short id or title words, accounts
// and initiatives by name, in the session's workspace only. Every term must
// match (AND), and % _ \ in the query match literally. The answer also carries
// the caller's role, so the palette hides the actions that role can't take.
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspace, user } = session;

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 200);
  const terms = splitTerms(q).slice(0, 8);
  if (terms.length === 0) {
    return NextResponse.json({ role: user.role, feedback: [], accounts: [], initiatives: [] } satisfies PaletteResponse);
  }

  // Each term in at least one of `cols`.
  // ponytail: ILIKE scans the workspace's rows; add pg_trgm indexes on the
  // searched columns if a large workspace makes ⌘K feel slow.
  const matchAll = (...cols: AnyColumn[]) =>
    and(...terms.map(t => or(...cols.map(c => ilike(c, likeContains(t))))));
  // "FB-12", "fb12" or "12" names one item; it matches even without the dash
  // and ranks first.
  const m = /^(?:fb-?)?(\d{1,9})$/i.exec(q);
  const exact = m ? `FB-${Number(m[1])}` : null;
  const itemMatch = matchAll(items.title, items.shortId);

  const [feedback, accts, inits] = await Promise.all([
    db.select({ shortId: items.shortId, title: items.title, status: items.status })
      .from(items)
      .where(and(eq(items.workspaceId, workspace.id), exact ? or(eq(items.shortId, exact), itemMatch) : itemMatch))
      .orderBy(...(exact ? [desc(sql`${items.shortId} = ${exact}`)] : []), desc(items.createdAt))
      .limit(PER_GROUP),
    db.select({ id: accounts.id, name: accounts.name, arrCents: accounts.arrCents })
      .from(accounts)
      .where(and(eq(accounts.workspaceId, workspace.id), matchAll(accounts.name)))
      .orderBy(desc(accounts.arrCents), asc(accounts.name))
      .limit(PER_GROUP),
    db.select({ id: initiatives.id, shortId: initiatives.shortId, name: initiatives.name })
      .from(initiatives)
      .where(and(eq(initiatives.workspaceId, workspace.id), matchAll(initiatives.name, initiatives.shortId)))
      .orderBy(desc(initiatives.updatedAt))
      .limit(PER_GROUP),
  ]);

  return NextResponse.json({
    role: user.role,
    feedback: feedback.map(r => ({ label: r.title, hint: `${r.shortId} · ${statusLabel(r.status)}`, href: `/thread/${r.shortId}` })),
    accounts: accts.map(a => ({ label: a.name, hint: a.arrCents > 0 ? `${formatArr(a.arrCents)} ARR` : undefined, href: `/accounts/${a.id}` })),
    initiatives: inits.map(i => ({ label: i.name, hint: i.shortId, href: `/initiatives/${i.id}` })),
  } satisfies PaletteResponse);
}
