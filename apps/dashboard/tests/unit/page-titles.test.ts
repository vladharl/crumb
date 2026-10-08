import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, initiatives, items, workspaces } from "@crumb/db";
import { generateMetadata as threadTitle } from "@/app/(app)/thread/[shortId]/page";
import { generateMetadata as accountTitle } from "@/app/(app)/accounts/[id]/page";
import { generateMetadata as initiativeTitle } from "@/app/(app)/initiatives/[id]/page";

// Tab titles for the detail pages. They read the session's workspace only, and
// an unknown, foreign or malformed id comes back as a plain "Not found" title:
// a throw in generateMetadata takes the whole page down, not just the title.
//
// Runs against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSession }));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

const tag = randomUUID().slice(0, 8);
const created: string[] = [];

// A workspace holding one thread (always FB-7), one account and one initiative,
// each named after the workspace.
async function workspace(name: string) {
  const [ws] = await db.insert(workspaces)
    .values({ slug: `page-titles-${tag}-${created.length}`, name })
    .returning({ id: workspaces.id });
  created.push(ws.id);
  const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: `${name} Corp` }).returning({ id: accounts.id });
  const [submitter] = await db.insert(accountUsers)
    .values({ workspaceId: ws.id, accountId: acct.id, email: "pat@acme.test", name: "Pat", initials: "P" })
    .returning({ id: accountUsers.id });
  await db.insert(items).values({
    workspaceId: ws.id, accountId: acct.id, submitterId: submitter.id,
    seq: 7, shortId: "FB-7", title: `${name} export`, type: "idea",
  });
  const [initiative] = await db.insert(initiatives)
    .values({ workspaceId: ws.id, seq: 1, shortId: "IN-1", name: `${name} roadmap` })
    .returning({ id: initiatives.id });
  return { id: ws.id, accountId: acct.id, initiativeId: initiative.id };
}

describe.skipIf(!reachable && !process.env.CI)("detail page titles", () => {
  afterAll(async () => {
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("names the thread, account and initiative from the session's workspace only", async () => {
    const alpha = await workspace("Alpha");
    const beta = await workspace("Beta");
    getSession.mockResolvedValue({ workspace: { id: alpha.id } });

    expect(await threadTitle({ params: { shortId: "FB-7" } })).toEqual({ title: "FB-7 · Alpha export" });
    expect(await accountTitle({ params: { id: alpha.accountId } })).toEqual({ title: "Alpha Corp" });
    expect(await initiativeTitle({ params: { id: alpha.initiativeId } })).toEqual({ title: "Alpha roadmap" });
    expect(await accountTitle({ params: { id: beta.accountId } })).toEqual({ title: "Not found" });
    expect(await initiativeTitle({ params: { id: beta.initiativeId } })).toEqual({ title: "Not found" });
  });

  it("falls back to a plain title for unknown or malformed ids instead of throwing", async () => {
    getSession.mockResolvedValue({ workspace: { id: randomUUID() } });
    // "\0" decodes from /thread/%00 and makes Postgres reject the query outright.
    for (const shortId of ["FB-999999", "\0"]) {
      expect(await threadTitle({ params: { shortId } })).toEqual({ title: "Not found" });
    }
    for (const id of ["not-a-uuid", randomUUID()]) {
      expect(await accountTitle({ params: { id } })).toEqual({ title: "Not found" });
      expect(await initiativeTitle({ params: { id } })).toEqual({ title: "Not found" });
    }

    getSession.mockResolvedValue(null);
    expect(await threadTitle({ params: { shortId: "FB-7" } })).toEqual({});
  });
});
