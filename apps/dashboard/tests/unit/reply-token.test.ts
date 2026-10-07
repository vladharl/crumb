import { afterAll, describe, it, expect, vi } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, items, replies, workspaces } from "@crumb/db";
import { parseReplyAddress, pickReplyTarget, signReplyToken } from "@/lib/reply-token";
import { POST as inboundReply } from "@/app/api/v1/inbound/reply/route";

// FB numbers are only unique per workspace, so on Cloud the inbound reply
// route finds one FB-42 per workspace that has one. The token, signed with the
// sending workspace's secret, must pick that workspace's item whatever order
// the rows come back in, and a forged token must pick none.
describe("lib/reply-token pickReplyTarget", () => {
  const acme = { workspace: "acme", signingSecret: "a".repeat(64) };
  const globex = { workspace: "globex", signingSecret: "b".repeat(64) };

  it("routes a reply to FB-42 to the workspace that sent the address", () => {
    // Pinned as already sent in a notification email: the address format and
    // signing scheme must not drift under emails customers still hold.
    const parsed = parseReplyAddress("Globex Support <reply+FB-42.a_lUyfadolBJxd3NPLXbIg@reply.crumb.test>");
    expect(parsed).toEqual({ shortId: "FB-42", token: "a_lUyfadolBJxd3NPLXbIg" });
    expect(pickReplyTarget(parsed!.shortId, parsed!.token, [acme, globex])).toBe(globex);
    expect(pickReplyTarget(parsed!.shortId, parsed!.token, [globex, acme])).toBe(globex);
    expect(pickReplyTarget("FB-42", signReplyToken("FB-42", acme.signingSecret), [globex, acme])).toBe(acme);
  });

  it("matches no workspace for a forged token", () => {
    const both = [acme, globex];
    expect(pickReplyTarget("FB-42", signReplyToken("FB-42", "attacker-secret"), both)).toBeNull();
    expect(pickReplyTarget("FB-42", signReplyToken("FB-41", acme.signingSecret), both)).toBeNull();
    expect(pickReplyTarget("FB-42", "a_lUyfadolBJxd3NPLXbIx", both)).toBeNull();
    expect(pickReplyTarget("FB-42", "", both)).toBeNull();
  });
});

// The route itself, against Postgres (DATABASE_URL, migrated via
// `pnpm db:migrate`). Skipped locally when no database answers; CI has one,
// so there it fails instead of skipping.
const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const tag = randomUUID().slice(0, 8);
const created: string[] = [];

describe.skipIf(!reachable && !process.env.CI)("POST /api/v1/inbound/reply", () => {
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("lands on the item of the workspace whose secret signed the address", async () => {
    vi.stubEnv("CRUMB_INBOUND_SECRET", "");
    const seq = randomInt(1_000_000, 2_000_000_000); // an FB number no other row has
    const shortId = `FB-${seq}`;
    // The same FB number and the same customer email in two workspaces.
    const workspaceWithItem = async (updatedAt: Date) => {
      const [ws] = await db.insert(workspaces).values({ slug: `reply-route-${tag}-${created.length}`, name: "Reply route" })
        .returning({ id: workspaces.id, secret: workspaces.signingSecret });
      created.push(ws.id);
      const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Acme" }).returning({ id: accounts.id });
      const [pat] = await db.insert(accountUsers)
        .values({ workspaceId: ws.id, accountId: acct.id, email: "pat@acme.test", name: "Pat", initials: "P" })
        .returning({ id: accountUsers.id });
      const [item] = await db.insert(items)
        .values({ workspaceId: ws.id, accountId: acct.id, submitterId: pat.id, seq, shortId, title: "Export breaks", type: "bug", updatedAt })
        .returning({ id: items.id });
      return { secret: ws.secret, itemId: item.id };
    };
    // The other workspace's item is stored first and is the most recently
    // active, so a first-row lookup in either order finds it, not the sender's.
    const other = await workspaceWithItem(new Date());
    const sender = await workspaceWithItem(new Date(Date.now() - 86_400_000));

    const res = await inboundReply(new Request("http://localhost/api/v1/inbound/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: `reply+${shortId}.${signReplyToken(shortId, sender.secret)}@reply.crumb.test`,
        from: "Pat <pat@acme.test>",
        text: "Still broken on v2",
      }),
    }));

    expect(await res.json()).toMatchObject({ ok: true, accepted: true });
    const landed = await db.select({ itemId: replies.itemId }).from(replies)
      .where(inArray(replies.itemId, [other.itemId, sender.itemId]));
    expect(landed).toEqual([{ itemId: sender.itemId }]);
  });
});
