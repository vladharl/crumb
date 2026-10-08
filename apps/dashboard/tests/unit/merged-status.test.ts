import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, accounts, accountUsers, items, statusEvents, workspaces } from "@crumb/db";
import { sign } from "@/lib/jwt";
import { customerStatusOf } from "@/lib/customer-status";
import { GET as listItems } from "@/app/api/v1/items/route";
import { GET as getThread } from "@/app/api/v1/items/[shortId]/route";

// A request merged into another reads to its customer like that one: the
// status emails already tell them its outcome, so the widget's list and thread
// and the hosted page (customerStatusOf) say the same, with nothing else of the
// other request: not its title, number, account or the merge note naming it.
//
// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("a merged request, to its customer", () => {
  let wsId = "", jwt = "", canonId = "", canonShort = "", dupId = "", dupShort = "";

  beforeAll(async () => {
    const [ws] = await db.insert(workspaces).values({ slug: `merged-${randomUUID().slice(0, 8)}`, name: "Southbeam" })
      .returning({ id: workspaces.id, slug: workspaces.slug, secret: workspaces.signingSecret });
    wsId = ws.id;
    const [acme, globex] = await db.insert(accounts).values([{ workspaceId: ws.id, name: "Acme" }, { workspaceId: ws.id, name: "Globex" }])
      .returning({ id: accounts.id });
    const [pat, gus] = await db.insert(accountUsers).values([
      { workspaceId: ws.id, accountId: acme!.id, email: "pat@acme.test", name: "Pat", initials: "P" },
      { workspaceId: ws.id, accountId: globex!.id, email: "gus@globex.test", name: "Gus", initials: "G" },
    ]).returning({ id: accountUsers.id });
    const seq = randomInt(1_000_000, 2_000_000_000);
    [canonShort, dupShort] = [`FB-${seq}`, `FB-${seq + 1}`];
    const [canon] = await db.insert(items).values({
      workspaceId: ws.id, accountId: globex!.id, submitterId: gus!.id, seq, shortId: canonShort,
      title: "Globex SSO rollout", body: "Okta for every Globex team", type: "idea", status: "planned",
    }).returning({ id: items.id });
    canonId = canon!.id;
    const [dup] = await db.insert(items).values({
      workspaceId: ws.id, accountId: acme!.id, submitterId: pat!.id, seq: seq + 1, shortId: dupShort,
      title: "SSO please", body: "Okta", type: "idea", status: "duplicate", mergedIntoId: canonId,
    }).returning({ id: items.id });
    dupId = dup!.id;
    await db.insert(statusEvents).values({ itemId: dupId, fromStatus: "open", toStatus: "duplicate", reason: `Merged into ${canonShort}` });
    jwt = sign({ iss: ws.slug, sub: "pat@acme.test", account_name: "Acme", exp: Math.floor(Date.now() / 1000) + 300 }, ws.secret);
  });

  afterAll(async () => {
    if (!wsId) return;
    await db.delete(items).where(eq(items.workspaceId, wsId));
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
  });

  const get = (path: string) => new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${jwt}` } });
  const list = async () => (await (await listItems(get("/api/v1/items"))).json()) as { items: Array<Record<string, unknown>> };
  const thread = async () =>
    (await (await getThread(get(`/api/v1/items/${dupShort}`), { params: { shortId: dupShort } })).json()) as { item: Record<string, unknown> };

  it("reads with the status of the request it joined, and nothing else of it", async () => {
    const l = await list();
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ short_id: dupShort, title: "SSO please", status: "planned", merged: true, turn: "yours" });
    const t = await thread();
    expect(t.item).toMatchObject({ status: "planned", merged: true, status_reason: null, status_changed_at: null });
    for (const payload of [l, t]) {
      const text = JSON.stringify(payload);
      for (const leak of ["Globex", `"${canonShort}"`, `${canonShort} `, "Merged into"]) expect(text).not.toContain(leak);
    }
    expect(await customerStatusOf(dupId)).toEqual({ status: "planned", merged: true });

    // The outcome closes their loop too.
    await db.update(items).set({ status: "shipped" }).where(eq(items.id, canonId));
    expect((await list()).items[0]).toMatchObject({ status: "shipped", merged: true, turn: "closed" });
    expect((await thread()).item.status).toBe("shipped");
  });

  it("never follows the other customer's own close, and leaves everything else alone", async () => {
    // "resolved" is Gus closing his own request, not an outcome for Pat.
    await db.update(items).set({ status: "resolved" }).where(eq(items.id, canonId));
    expect(await customerStatusOf(dupId)).toEqual({ status: "duplicate", merged: true });
    expect(await customerStatusOf(canonId)).toEqual({ status: "resolved", merged: false });

    // Moved on its own after the merge (its thread, the bulk bar): its own status.
    await db.update(items).set({ status: "progress" }).where(eq(items.id, dupId));
    expect(await customerStatusOf(dupId)).toEqual({ status: "progress", merged: false });
    // Marked Duplicate without a merge: nothing to follow.
    await db.update(items).set({ status: "duplicate", mergedIntoId: null }).where(eq(items.id, dupId));
    expect(await customerStatusOf(dupId)).toEqual({ status: "duplicate", merged: false });
    expect(await customerStatusOf(randomUUID())).toBeNull();
  });
});
