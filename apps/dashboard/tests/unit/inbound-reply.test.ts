import { afterAll, describe, expect, it, vi } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, inboundCaptures, items, replies, workspaces } from "@crumb/db";
import { signReplyToken } from "@/lib/reply-token";
import { POST as inboundReply } from "@/app/api/v1/inbound/reply/route";

// Email replies are safe to retry and never vanish (audit #55): a provider
// retry of the same Message-ID posts once, the provider's 200 doesn't wait on
// the vendor notification, and a sender who isn't on the account lands in
// captures for review, naming the thread, instead of being dropped, with the
// metered AI account suggestion run once, not again on each retry.

// AI on: an entitled workspace and a suggester that counts its runs.
const suggest = vi.hoisted(() => vi.fn(async () => ({ accountId: null, accountName: null, confidence: 0 })));
vi.mock("@/lib/ai/match-account", () => ({ matchAccountConfigured: () => true, suggestAccount: suggest }));
vi.mock("@/lib/entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements")>()),
  hasFeature: () => true,
}));
vi.mock("@/lib/ai/run", () => ({ withAiBudget: async (_ws: unknown, fn: () => Promise<unknown>) => ({ ok: true, value: await fn() }) }));

// Never settles, so the route only answers if it doesn't await it.
const notify = vi.hoisted(() => vi.fn(() => new Promise<void>(() => {})));
vi.mock("@/lib/customer-reply-notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/customer-reply-notify")>()),
  notifyVendorsOfCustomerReply: notify,
}));

// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.
const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const created: string[] = [];

async function thread() {
  const [ws] = await db.insert(workspaces).values({ slug: `inbound-reply-${randomUUID().slice(0, 8)}`, name: "Inbound reply" })
    .returning({ id: workspaces.id, secret: workspaces.signingSecret });
  created.push(ws!.id);
  const [acct] = await db.insert(accounts).values({ workspaceId: ws!.id, name: "Acme" }).returning({ id: accounts.id });
  const [pat] = await db.insert(accountUsers)
    .values({ workspaceId: ws!.id, accountId: acct!.id, email: "pat@acme.test", name: "Pat", initials: "P" })
    .returning({ id: accountUsers.id });
  const seq = randomInt(1_000_000, 2_000_000_000);
  const shortId = `FB-${seq}`;
  const [item] = await db.insert(items)
    .values({ workspaceId: ws!.id, accountId: acct!.id, submitterId: pat!.id, seq, shortId, title: "Export breaks", type: "bug" })
    .returning({ id: items.id });
  const to = `reply+${shortId}.${signReplyToken(shortId, ws!.secret)}@reply.crumb.test`;
  const send = async (from: string, messageId: string) => {
    const res = await inboundReply(new Request("http://localhost/api/v1/inbound/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, from, subject: "Re: Export breaks", text: "Still broken on v2\n\nOn Mon, Sam wrote:\n> Fixed?", message_id: messageId }),
    }));
    expect(res.status).toBe(200);
    return res.json();
  };
  return { workspaceId: ws!.id, itemId: item!.id, shortId, send };
}

describe.skipIf(!reachable && !process.env.CI)("POST /api/v1/inbound/reply retries and strangers", () => {
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("posts a retried email once and answers without waiting on the vendor notification", async () => {
    vi.stubEnv("CRUMB_INBOUND_SECRET", "");
    const t = await thread();
    expect(await t.send("Pat <pat@acme.test>", "<m1@mail.acme.test>")).toEqual({ ok: true, accepted: true, shortId: t.shortId });
    expect(await t.send("Pat <pat@acme.test>", "m1@mail.acme.test")).toEqual({ ok: true, accepted: false, reason: "duplicate" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await db.select({ body: replies.body, messageId: replies.inboundMessageId }).from(replies).where(eq(replies.itemId, t.itemId)))
      .toEqual([{ body: "Still broken on v2", messageId: "m1@mail.acme.test" }]);
  });

  it("holds a reply from an address not on the account as a capture naming the thread", async () => {
    vi.stubEnv("CRUMB_INBOUND_SECRET", "");
    const t = await thread();
    const first = await t.send("Jordan Park <jordan@elsewhere.test>", "<m2@mail.elsewhere.test>");
    expect(first).toEqual({ ok: true, accepted: false, reason: "unknown_sender", captureId: expect.any(String) });
    expect(await t.send("Jordan Park <jordan@elsewhere.test>", "<m2@mail.elsewhere.test>"))
      .toEqual({ ok: true, accepted: false, reason: "duplicate" });
    expect(suggest).toHaveBeenCalledTimes(1);

    const captures = await db
      .select({ id: inboundCaptures.id, source: inboundCaptures.source, status: inboundCaptures.status, fromEmail: inboundCaptures.fromEmail, fromName: inboundCaptures.fromName, body: inboundCaptures.body })
      .from(inboundCaptures)
      .where(eq(inboundCaptures.workspaceId, t.workspaceId));
    expect(captures).toEqual([{
      id: first.captureId,
      source: "email",
      status: "pending",
      fromEmail: "jordan@elsewhere.test",
      fromName: "Jordan Park",
      body: `Emailed reply to ${t.shortId} (Export breaks) from an address that isn't on its account.\n\nStill broken on v2`,
    }]);
    expect(await db.select({ id: replies.id }).from(replies).where(eq(replies.itemId, t.itemId))).toEqual([]);
  });
});
