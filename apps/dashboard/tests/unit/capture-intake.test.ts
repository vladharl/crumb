import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, inboundCaptures, items, workspaces, workspaceUsers } from "@crumb/db";

// Captures waiting in the Inbox always become requests: one with no sender
// address (a Gong call, a Freshdesk ticket) is filed under a reserved .invalid
// placeholder nobody is emailed at, and only an http(s) link back to the
// source is kept. Someone whose feedback was marked as spam is turned away by
// every capture route, Autopilot's connectors included, and nothing of theirs
// is stored.
//
// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.

const h = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/lib/server", () => ({ getActiveSession: async () => h.session }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/webhooks", () => ({ emitEvent: async () => {} }));
vi.mock("@/lib/notify/chat", () => ({ notifyWorkspaceChannel: async () => {} }));
vi.mock("@/lib/vendor-notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vendor-notify")>()),
  notifyNewSubmission: async () => {},
}));

import { createItemFromCapture } from "@/app/(app)/captures/actions";
import { createInboundCapture } from "@/lib/captures";
import { ingestRecord } from "@/lib/feedback/ingest";

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const created: string[] = [];

async function workspace() {
  const [ws] = await db.insert(workspaces)
    .values({ slug: `capture-intake-${randomUUID().slice(0, 8)}`, name: "Capture intake" })
    .returning();
  created.push(ws!.id);
  const [acct] = await db.insert(accounts).values({ workspaceId: ws!.id, name: "Initech" }).returning({ id: accounts.id });
  const [admin] = await db.insert(workspaceUsers)
    .values({ workspaceId: ws!.id, email: "lina@vendor.test", name: "Lina", initials: "L", role: "admin" })
    .returning({ id: workspaceUsers.id });
  h.session = { workspace: ws!, user: { id: admin!.id, role: "admin" } };
  return { row: ws!, accountId: acct!.id };
}

describe.skipIf(!reachable && !process.env.CI)("capture intake", () => {
  afterAll(async () => {
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("accepts a capture with no sender address, and keeps only an http(s) source link", async () => {
    const ws = await workspace();
    const capture = (externalId: string, fromEmail: string | null, url: string) => createInboundCapture(ws.row, {
      source: "gong", fromEmail, fromName: null, subject: "Weekly sync", body: "We need SSO.", externalId, rawMeta: { url },
    });
    const filed = async (captureId: string) => (await db
      .select({ email: accountUsers.email, name: accountUsers.name, source: items.source, sourceUrl: items.sourceUrl, status: inboundCaptures.status })
      .from(inboundCaptures)
      .innerJoin(items, eq(items.id, inboundCaptures.createdItemId))
      .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
      .where(eq(inboundCaptures.id, captureId)))[0];

    // Left blank: a placeholder of its own, which customerNotifyPlan and the
    // email sender both refuse, so nobody is emailed.
    const blank = (await capture("c1#0", null, "javascript:alert(1)"))!;
    expect(await createItemFromCapture({ captureId: blank, accountName: "Initech", submitterEmail: " ", type: "idea", title: "SSO" }))
      .toMatchObject({ ok: true });
    expect(await filed(blank)).toEqual({
      email: `gong-${blank}@capture.invalid`, name: "Unknown sender", source: "gong", sourceUrl: null, status: "accepted",
    });

    // An address typed in place of an unusable one is used as is.
    const typed = (await capture("c2#0", "maya", "https://acme.app.gong.io/call?id=2"))!;
    expect(await createItemFromCapture({ captureId: typed, accountName: "Initech", submitterEmail: "Maya@Initech.test", type: "idea", title: "SSO" }))
      .toMatchObject({ ok: true });
    expect(await filed(typed)).toMatchObject({ email: "maya@initech.test", sourceUrl: "https://acme.app.gong.io/call?id=2" });
  });

  it("turns a sender marked as spam away from the connectors and the capture routes", async () => {
    const ws = await workspace();
    await db.insert(accountUsers).values({
      workspaceId: ws.row.id, accountId: ws.accountId, email: "spam@initech.test", name: "Spam", initials: "S", blockedAt: new Date(),
    });
    const record = (externalId: string, authorEmail: string) => ({
      externalId, authorEmail, authorName: null, subject: "Buy now", text: "Buy now", url: null, occurredAt: null,
    });

    // Autopilot keeps nothing of theirs, whatever the case of the address.
    expect(await ingestRecord(ws.row, "zendesk", record("t1", "SPAM@initech.test"))).toMatchObject({ skipped: 1, held: 0 });
    // The extension API shares createInboundCapture with the email routes.
    expect(await createInboundCapture(ws.row, {
      source: "extension", fromEmail: "spam@initech.test", fromName: null, subject: null, body: "Buy now",
    })).toBeNull();
    expect(await db.select({ id: inboundCaptures.id }).from(inboundCaptures).where(eq(inboundCaptures.workspaceId, ws.row.id)))
      .toEqual([]);

    // Anyone else still comes in.
    expect(await ingestRecord(ws.row, "zendesk", record("t2", "sam@initech.test"))).toMatchObject({ skipped: 0, held: 1 });
  });
});
