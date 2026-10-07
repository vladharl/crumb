import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, accounts, accountUsers, attachments, items, replies, statusEvents, workspaces, workspaceUsers } from "@crumb/db";
import { sign } from "@/lib/jwt";
import { __resetKeyringForTests } from "@/lib/crypto-at-rest";
import { GET as listItems, POST as createItem } from "@/app/api/v1/items/route";
import { GET as getThread } from "@/app/api/v1/items/[shortId]/route";
import * as channels from "@/app/api/v1/account/integrations/webhook/route";
import { OPTIONS as membersPreflight } from "@/app/api/v1/members/route";

// The server half of the widget batch, through the real route handlers:
//   S1 #50  the list's unread signal counts vendor replies only
//   S2 #49  the thread carries the current status's reason
//   S3 #71  a submission's page/browser/build context is stored, redacted,
//           and its compose files ride on its first message
//   S4 #77  account admins can see (masked) and remove their channel webhooks
//
// Runs against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`).
// Skipped locally when no database answers; CI has one, so there it fails.

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const tag = randomUUID().slice(0, 8);
let wsId: string | null = null;

const req = (path: string, jwt: string | null, init: { method?: string; body?: unknown } = {}) =>
  new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

describe.skipIf(!reachable && !process.env.CI)("widget API contracts", () => {
  let admin = "", member = "", vendorId = "", patId = "", acctId = "";
  let shortId = "", itemId = "";

  beforeAll(async () => {
    const [ws] = await db.insert(workspaces).values({ slug: `widget-api-${tag}`, name: "Widget API" })
      .returning({ id: workspaces.id, slug: workspaces.slug, secret: workspaces.signingSecret });
    wsId = ws.id;
    const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Acme" }).returning({ id: accounts.id });
    acctId = acct.id;
    const users = await db.insert(accountUsers).values([
      { workspaceId: ws.id, accountId: acct.id, email: "pat@acme.test", name: "Pat", initials: "P", role: "admin" },
      { workspaceId: ws.id, accountId: acct.id, email: "max@acme.test", name: "Max", initials: "M", role: "member" },
    ]).returning({ id: accountUsers.id, email: accountUsers.email });
    patId = users.find(u => u.email === "pat@acme.test")!.id;
    const [sam] = await db.insert(workspaceUsers)
      .values({ workspaceId: ws.id, email: "sam@vendor.test", name: "Sam", initials: "S" })
      .returning({ id: workspaceUsers.id });
    vendorId = sam.id;
    const jwt = (sub: string) => sign({ iss: ws.slug, sub, account_name: "Acme", exp: Math.floor(Date.now() / 1000) + 300 }, ws.secret);
    admin = jwt("pat@acme.test");
    member = jwt("max@acme.test");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    __resetKeyringForTests();
    if (!wsId) return;
    await db.delete(items).where(eq(items.workspaceId, wsId));
    await db.delete(attachments).where(eq(attachments.storageKey, `test/${tag}`)); // if never linked
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
  });

  it("S3: a submission stores its context capped and redacted, bad context never blocks it, and its files ride on its first message", async () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
    const [shot] = await db.insert(attachments)
      .values({ filename: "export.png", contentType: "image/png", sizeBytes: 1, storageKey: `test/${tag}`, uploadedByAccountUserId: patId })
      .returning({ id: attachments.id });
    const res = await createItem(req("/api/v1/items", admin, {
      method: "POST",
      body: {
        type: "bug", title: "Export is empty", body: "The CSV has headers only.", attachment_ids: [shot.id],
        context: {
          page_url: "https://pat:pw@app.acme.test/reports?id=7&token=abc#tab=csv",
          page_title: "Reports",
          referrer: "javascript:alert(1)",
          user_agent: ua,
          viewport: { w: 1280, h: 720 },
          locale: "en-GB",
          app_version: "4.2.1",
        },
      },
    }));
    expect(res.status).toBe(201);
    shortId = (await res.json()).short_id;
    const [row] = await db.select({ id: items.id, context: items.context }).from(items)
      .where(and(eq(items.workspaceId, wsId!), eq(items.shortId, shortId)));
    itemId = row.id;
    expect(row.context).toEqual({
      page_url: "https://app.acme.test/reports?id=7&token=[redacted]#tab=csv",
      page_title: "Reports",
      user_agent: ua,
      viewport: { w: 1280, h: 720 },
      locale: "en-GB",
      app_version: "4.2.1",
    });
    // One message, with the screenshot on it: no empty follow-up reply (S1 counts it).
    const msgs = await db.select({ id: replies.id }).from(replies).where(eq(replies.itemId, itemId));
    expect(msgs).toHaveLength(1);
    const [att] = await db.select({ replyId: attachments.replyId }).from(attachments).where(eq(attachments.id, shot.id));
    expect(att.replyId).toBe(msgs[0]!.id);

    const junk = await createItem(req("/api/v1/items", admin, {
      method: "POST", body: { type: "idea", title: "Dark mode", context: "not an object" },
    }));
    expect(junk.status).toBe(201);
    const [plain] = await db.select({ context: items.context }).from(items)
      .where(and(eq(items.workspaceId, wsId!), eq(items.shortId, (await junk.json()).short_id)));
    expect(plain.context).toBeNull();
  });

  it("S1: the list's vendor numbers ignore the customer's own messages and internal notes", async () => {
    const mine = async () => {
      const res = await listItems(req("/api/v1/items", admin));
      expect(res.status).toBe(200);
      return (await res.json()).items.find((i: { short_id: string }) => i.short_id === shortId);
    };

    // Right after sending, the only message is the customer's own body.
    let it1 = await mine();
    expect(it1.reply_count).toBe(1); // existing field, unchanged
    expect(it1.vendor_reply_count).toBe(0);
    expect(it1.last_vendor_reply_at).toBeNull();

    const now = Date.now();
    await db.insert(replies).values([
      { itemId, workspaceUserId: vendorId, body: "Looking at the logs", internal: true, createdAt: new Date(now + 1_000) },
      { itemId, workspaceUserId: vendorId, body: "Fixed in 4.2.2", internal: false, createdAt: new Date(now + 2_000) },
      { itemId, accountUserId: patId, body: "Thanks!", internal: false, createdAt: new Date(now + 3_000) },
    ]);
    it1 = await mine();
    expect(it1.vendor_reply_count).toBe(1);
    expect(it1.last_vendor_reply_at).toBe(new Date(now + 2_000).toISOString());
    expect(it1.reply_count).toBe(3);
    // The customer moved last, so last_event is not the vendor's reply.
    expect(it1.last_event.at).toBe(new Date(now + 3_000).toISOString());
  });

  it("S2: the thread carries the current status's reason and when it changed", async () => {
    const thread = async () => {
      const res = await getThread(req(`/api/v1/items/${shortId}`, admin), { params: { shortId } });
      expect(res.status).toBe(200);
      return (await res.json()).item;
    };

    let item = await thread();
    expect(item.status_reason).toBeNull();
    expect(Number.isNaN(Date.parse(item.status_changed_at))).toBe(false);

    const at = new Date(Date.now() + 10_000);
    await db.update(items).set({ status: "declined" }).where(eq(items.id, itemId));
    await db.insert(statusEvents).values({
      itemId, fromStatus: "open", toStatus: "declined", reason: "Not in v2: the export rewrite replaces it.", byWorkspaceUserId: vendorId, at,
    });
    item = await thread();
    expect(item.status_reason).toBe("Not in v2: the export rewrite replaces it.");
    expect(item.status_changed_at).toBe(at.toISOString());

    // A status written without an event (capture-time merge) doesn't borrow
    // the older decline's reason or time.
    await db.update(items).set({ status: "duplicate" }).where(eq(items.id, itemId));
    item = await thread();
    expect(item.status_reason).toBeNull();
    expect(item.status_changed_at).toBeNull();
  });

  it("S4: account admins list (masked) and remove channel webhooks; nobody else can", async () => {
    vi.stubEnv("CRUMB_ENCRYPTION_KEY", "ab".repeat(32));
    __resetKeyringForTests();
    const path = "/api/v1/account/integrations/webhook";
    const list = async (jwt: string | null) => channels.GET(req(path, jwt));

    expect(await (await list(admin)).json()).toEqual({
      slack: { connected: false, masked_url: null },
      teams: { connected: false, masked_url: null },
    });

    const secretPart = "B0000/abcdefghijklWXYZ";
    const saved = await channels.POST(req(path, admin, {
      method: "POST", body: { provider: "slack", url: `https://hooks.slack.com/services/T0000/${secretPart}` },
    }));
    expect(saved.status).toBe(200);
    const [acct] = await db.select({ slack: accounts.slackWebhookUrl }).from(accounts).where(eq(accounts.id, acctId));
    expect(acct.slack).not.toContain(secretPart); // sealed at rest

    const listed = await (await list(admin)).json();
    expect(listed.slack).toEqual({ connected: true, masked_url: "hooks.slack.com/…WXYZ" });
    expect(listed.teams).toEqual({ connected: false, masked_url: null });
    expect(JSON.stringify(listed)).not.toContain("abcdefghijkl");

    // Same gate as today: members and anonymous callers get nothing.
    expect((await list(member)).status).toBe(403);
    expect((await list(null)).ok).toBe(false);
    expect((await channels.DELETE(req(`${path}?provider=slack`, member, { method: "DELETE" }))).status).toBe(403);
    expect((await list(admin)).ok).toBe(true);

    expect((await channels.POST(req(path, admin, { method: "POST", body: { provider: "teams", url: 42 } }))).status).toBe(400);
    expect((await channels.DELETE(req(`${path}?provider=email`, admin, { method: "DELETE" }))).status).toBe(400);
    expect((await channels.DELETE(req(`${path}?provider=slack`, admin, { method: "DELETE" }))).status).toBe(200);
    expect((await (await list(admin)).json()).slack).toEqual({ connected: false, masked_url: null });

    // The widget calls cross-origin, so the preflights have to allow DELETE,
    // and PATCH for the Admin tab's role change.
    expect(channels.OPTIONS().headers.get("access-control-allow-methods")).toContain("DELETE");
    const memberVerbs = membersPreflight().headers.get("access-control-allow-methods");
    expect(memberVerbs).toContain("PATCH");
    expect(memberVerbs).toContain("DELETE");
  });
});
