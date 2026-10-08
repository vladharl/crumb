import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, accounts, accountUsers, items, workspaces } from "@crumb/db";

// Two "Create ticket"s on one item at once (two teammates, two tabs) both pass
// the not-linked check and both make a tracker issue; the first link stands,
// the other says already_linked, and ticket.linked fires once.
//
// Against Postgres (DATABASE_URL, migrated). Skipped locally when no database
// answers; CI has one, so there it fails instead of skipping.

const h = vi.hoisted(() => ({ session: null as unknown, createIssue: vi.fn(), emit: vi.fn() }));
vi.mock("@/lib/integrations/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/github")>()),
  createIssue: h.createIssue,
}));
vi.mock("@/lib/webhooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webhooks")>()),
  emitEvent: h.emit,
}));
vi.mock("@/lib/server", () => ({ getActiveSession: async () => h.session }));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { createExternalTicket } from "@/app/(app)/thread/[shortId]/actions";

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const tag = randomUUID().slice(0, 8);
let wsId = "";

describe.skipIf(!reachable && !process.env.CI)("createExternalTicket", () => {
  afterAll(async () => {
    if (!wsId) return;
    await db.delete(items).where(eq(items.workspaceId, wsId));
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
  });

  it("keeps the first link when two creates race", async () => {
    vi.stubEnv("CRUMB_TIER", "self_host"); // integrations need no plan there
    const [ws] = await db.insert(workspaces)
      .values({ slug: `ticket-race-${tag}`, name: "Ticket race", githubAppInstallId: "1", githubDefaultRepo: "acme/app" })
      .returning();
    wsId = ws.id;
    const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Acme" }).returning({ id: accounts.id });
    const [pat] = await db.insert(accountUsers)
      .values({ workspaceId: ws.id, accountId: acct.id, email: "pat@acme.test", name: "Pat", initials: "P" })
      .returning({ id: accountUsers.id });
    const [item] = await db.insert(items).values({
      workspaceId: ws.id, accountId: acct.id, submitterId: pat.id, seq: 1, shortId: "FB-1", title: "Export", type: "bug",
    }).returning({ id: items.id });
    h.session = { workspace: ws, user: { id: "u-1", role: "admin" } };

    // Both calls reach the tracker before either links.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let n = 0;
    h.createIssue.mockImplementation(async () => {
      const num = ++n;
      await gate;
      return { number: num, nodeId: `I_${num}_${tag}`, url: `https://github.com/acme/app/issues/${num}`, title: "Export", state: "open" };
    });
    const input = { itemShortId: "FB-1", provider: "github" as const, title: "Export", body: "", target: "acme/app" };
    const both = Promise.all([createExternalTicket(input), createExternalTicket(input)]);
    await vi.waitFor(() => expect(h.createIssue).toHaveBeenCalledTimes(2));
    release();
    const results = await both;

    const won = results.filter(r => r.ok);
    expect(won).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, error: "already_linked" }]);
    const [row] = await db.select({ id: items.externalTicketId }).from(items).where(eq(items.id, item.id));
    expect(row.id).toBe(won[0]!.ok && won[0]!.externalTicketId);
    expect(h.emit).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});
