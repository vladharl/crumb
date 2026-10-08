import { afterAll, describe, it, expect } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, attachments, items, replies, workspaces, workspaceUsers } from "@crumb/db";
import { hostedThreadPath, loadHostedThread } from "@/lib/hosted-thread";
import { pickReplyTarget, signReplyToken } from "@/lib/reply-token";

// The hosted thread (app/t) is a public page guarded only by the token in its
// path. It must open only the thread of the workspace that signed the link,
// show only what the customer sees, and never share a key with the
// reply-by-email address, which can post to the thread.

const tokenOf = (path: string) => path.split("/").pop()!;

describe("hosted thread links", () => {
  it("never double as a reply address, or the other way round", () => {
    const ws = { signingSecret: "a".repeat(64) };
    const path = hostedThreadPath("FB-42", ws.signingSecret);
    expect(path).toMatch(/^\/t\/FB-42\/[\w-]+$/);
    expect(pickReplyTarget("FB-42", tokenOf(path), [ws])).toBeNull();
    expect(tokenOf(path)).not.toBe(signReplyToken("FB-42", ws.signingSecret));
  });
});

// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.
const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const created: string[] = [];

describe.skipIf(!reachable && !process.env.CI)("loadHostedThread", () => {
  afterAll(async () => {
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("opens the signing workspace's thread, without internal notes", async () => {
    // The same FB number in two workspaces, each with a thread.
    const seq = randomInt(1_000_000, 2_000_000_000);
    const shortId = `FB-${seq}`;
    const workspaceWithThread = async (name: string) => {
      const [ws] = await db.insert(workspaces).values({ slug: `hosted-${randomUUID().slice(0, 8)}`, name })
        .returning({ id: workspaces.id, secret: workspaces.signingSecret });
      created.push(ws.id);
      const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Initech" }).returning({ id: accounts.id });
      const [pat] = await db.insert(accountUsers)
        .values({ workspaceId: ws.id, accountId: acct.id, email: "pat@initech.test", name: "Pat", initials: "P" })
        .returning({ id: accountUsers.id });
      const [lina] = await db.insert(workspaceUsers)
        .values({ workspaceId: ws.id, email: "lina@vendor.test", name: "Lina", initials: "L" })
        .returning({ id: workspaceUsers.id });
      const [item] = await db.insert(items)
        .values({ workspaceId: ws.id, accountId: acct.id, submitterId: pat.id, seq, shortId, title: `${name} export`, body: "CSV export fails", type: "bug" })
        .returning({ id: items.id });
      const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s));
      const [, vendorReply] = await db.insert(replies).values([
        { itemId: item.id, accountUserId: pat.id, body: "Any news?", createdAt: at(1) },
        { itemId: item.id, workspaceUserId: lina.id, body: `${name} says it's fixed`, createdAt: at(2) },
        { itemId: item.id, workspaceUserId: lina.id, body: "Internal: churn risk", internal: true, createdAt: at(3) },
      ]).returning({ id: replies.id });
      await db.insert(attachments).values({
        replyId: vendorReply!.id, filename: "fix.png", contentType: "image/png", sizeBytes: 3, storageKey: `test/${randomUUID()}`,
      });
      return ws.secret;
    };
    const acme = await workspaceWithThread("Acme");
    const globex = await workspaceWithThread("Globex");

    const thread = await loadHostedThread(shortId, tokenOf(hostedThreadPath(shortId, globex)));
    expect(thread?.item).toMatchObject({ title: "Globex export", body: "CSV export fails", workspaceName: "Globex" });
    expect(thread?.item).not.toHaveProperty("signingSecret");
    expect(thread?.messages.map(m => [m.author, m.fromVendor, m.body])).toEqual([
      ["Pat", false, "Any news?"],
      ["Lina", true, "Globex says it's fixed"],
    ]);
    expect(thread?.messages[1]?.files).toEqual([
      { name: "fix.png", href: expect.stringMatching(/^\/api\/v1\/uploads\/[\w-]+\?exp=\d+&sig=[\w-]+$/) },
    ]);

    expect((await loadHostedThread(shortId, tokenOf(hostedThreadPath(shortId, acme))))?.item.workspaceName).toBe("Acme");
    // A reply address's token, a forged one, or another item's never open it.
    expect(await loadHostedThread(shortId, signReplyToken(shortId, globex))).toBeNull();
    expect(await loadHostedThread(shortId, tokenOf(hostedThreadPath(shortId, "attacker-secret")))).toBeNull();
    expect(await loadHostedThread(shortId, tokenOf(hostedThreadPath(`FB-${seq + 1}`, globex)))).toBeNull();
  });

  it("shows the customer's original message once", async () => {
    // Creating an item seeds its thread with the body as the first message.
    const seq = randomInt(1_000_000, 2_000_000_000);
    const shortId = `FB-${seq}`;
    const [ws] = await db.insert(workspaces).values({ slug: `hosted-${randomUUID().slice(0, 8)}`, name: "Initrode" })
      .returning({ id: workspaces.id, secret: workspaces.signingSecret });
    created.push(ws.id);
    const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Initech" }).returning({ id: accounts.id });
    const [pat] = await db.insert(accountUsers)
      .values({ workspaceId: ws.id, accountId: acct.id, email: "pat@initech.test", name: "Pat", initials: "P" })
      .returning({ id: accountUsers.id });
    const [item] = await db.insert(items)
      .values({ workspaceId: ws.id, accountId: acct.id, submitterId: pat.id, seq, shortId, title: "Exports", body: "Exports drop the last row", type: "bug" })
      .returning({ id: items.id });
    await db.insert(replies).values([
      { itemId: item.id, accountUserId: pat.id, body: "Exports drop the last row", createdAt: new Date(Date.UTC(2026, 9, 1, 12)) },
      { itemId: item.id, accountUserId: pat.id, body: "Still happening", createdAt: new Date(Date.UTC(2026, 9, 2, 12)) },
    ]);

    const thread = await loadHostedThread(shortId, tokenOf(hostedThreadPath(shortId, ws.secret)));
    expect(thread?.item.body).toBe("");
    expect(thread?.messages.map(m => [m.author, m.body])).toEqual([["Pat", "Exports drop the last row"], ["Pat", "Still happening"]]);
  });
});
