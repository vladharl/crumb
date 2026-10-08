import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { OutgoingEmail } from "@/lib/email/provider";

// Every email lands here. Named anything but "stdout", so lib/email treats it
// as a real provider and the senders report the send as delivered.
const sent = vi.hoisted(() => [] as OutgoingEmail[]);
vi.mock("@/lib/email/stdout", () => ({
  stdoutProvider: {
    name: "test",
    send: async (m: OutgoingEmail) => { sent.push(m); return { ok: true as const, providerMessageId: null }; },
  },
}));

import {
  db, accounts, accountUsers, items, notificationPreferences, replies, statusEvents, workspaceUsers, workspaces, magicTokens
} from "@crumb/db";
import { sendMagicLink } from "@/lib/email";
import { syncExternalStatus } from "@/lib/webhooks";
import { notifyVendorsOfCustomerReply } from "@/lib/customer-reply-notify";
import { SAMPLE_ACCOUNT_EXTERNAL_ID } from "@/lib/samples";
import {
  digestWindow, notifyAssigned, notifyAssignedMany, notifyNewSubmission, nudgeChannel, sendDigests,
} from "@/lib/vendor-notify";

const recipients = () => sent.splice(0).map(e => e.to).sort();
const settle = () => new Promise(r => setTimeout(r, 300));

describe("nudgeChannel", () => {
  it("honours a saved row as saved", () => {
    expect(nudgeChannel("replyRealtime", "pm", { on: true, delivery: "slack" })).toBe("slack");
    expect(nudgeChannel("replyRealtime", "pm", { on: true, delivery: "email" })).toBe("email");
    expect(nudgeChannel("replyRealtime", "admin", { on: false, delivery: "email" })).toBeNull();
    expect(nudgeChannel("mentionRealtime", "admin", { on: true, delivery: "none" })).toBeNull();
    expect(nudgeChannel("newSubmissionRealtime", "viewer", { on: true, delivery: "email" })).toBe("email");
  });

  it("without a row: on by email, but new submissions only for admins", () => {
    for (const pref of ["replyRealtime", "mentionRealtime", "assignedRealtime"] as const) {
      expect(nudgeChannel(pref, "pm", null)).toBe("email");
    }
    expect(nudgeChannel("newSubmissionRealtime", "admin", null)).toBe("email");
    expect(nudgeChannel("newSubmissionRealtime", "pm", null)).toBeNull();
  });
});

describe("digestWindow", () => {
  const now = Date.parse("2026-10-08T09:00:00Z");
  const ago = (h: number) => new Date(now - h * 3_600_000);

  it("is due at most once per period and covers the time since the last one", () => {
    expect(digestWindow("off", null, now)).toBeNull();
    expect(digestWindow("daily", ago(19), now)).toBeNull();
    expect(digestWindow("daily", ago(21), now)).toEqual({ cadence: "daily", since: ago(21), first: false });
    expect(digestWindow("weekly", ago(6 * 24), now)).toBeNull();
    expect(digestWindow("weekly", ago(6.6 * 24), now)?.cadence).toBe("weekly");
  });

  it("a first digest covers one period", () => {
    expect(digestWindow("daily", null, now)).toEqual({ cadence: "daily", since: ago(24), first: true });
    expect(digestWindow("weekly", null, now)?.since).toEqual(ago(7 * 24));
  });
});

describe("the email layer", () => {
  it("never sends to a reserved .invalid address", async () => {
    sent.length = 0;
    await sendMagicLink({ to: "slack-U1@slack.invalid", link: "https://crumb.test/l", ttlMinutes: 15 });
    await sendMagicLink({ to: "Dev <dev@Sample-Co.INVALID>", link: "https://crumb.test/l", ttlMinutes: 15 });
    expect(sent).toHaveLength(0);
    await sendMagicLink({ to: "pat@acme.test", link: "https://crumb.test/l", ttlMinutes: 15 });
    expect(recipients()).toEqual(["pat@acme.test"]);
  });
});

// The rest runs against Postgres (DATABASE_URL, migrated): skipped locally when
// no database answers, failing in CI instead.
const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("vendor notifications", () => {
  const APP = "https://crumb.example.test";
  let ws = "";
  const m = { ada: "", bo: "", pia: "", quin: "", ivy: "" }; // ada, bo: admins; pia, quin: pms; ivy: an invited admin who never accepted
  const fb: Record<number, string> = {};

  beforeAll(async () => {
    vi.stubEnv("CRUMB_APP_URL", APP);
    const [w] = await db.insert(workspaces)
      .values({ slug: `vendor-notify-${randomUUID().slice(0, 8)}`, name: "Vendor notify test" })
      .returning({ id: workspaces.id });
    ws = w.id;
    const users = await db.insert(workspaceUsers).values([
      { workspaceId: ws, email: "ada@vendor.test", name: "Ada", initials: "A", role: "admin" },
      { workspaceId: ws, email: "bo@vendor.test", name: "Bo", initials: "B", role: "admin" },
      { workspaceId: ws, email: "pia@vendor.test", name: "Pia", initials: "P", role: "pm" },
      { workspaceId: ws, email: "quin@vendor.test", name: "Quin", initials: "Q", role: "pm" },
      { workspaceId: ws, email: "ivy@vendor-typo.test", name: "Ivy", initials: "I", role: "admin" },
    ]).returning({ id: workspaceUsers.id, name: workspaceUsers.name });
    for (const u of users) m[u.name.toLowerCase() as keyof typeof m] = u.id;
    // Ivy's invite was never used (a mistyped address): no alert or digest
    // with customer names and ARR may reach her, though admins get both by default.
    await db.insert(magicTokens).values({ workspaceId: ws, workspaceUserId: m.ivy, token: randomUUID().replace(/-/g, ""), expiresAt: new Date(Date.now() - 86_400_000) });
    // Bo muted customer replies. Quin took new submissions, muted replies and
    // assignments, and turned the digest off. Ada and Pia never saved any.
    await db.insert(notificationPreferences).values([
      { workspaceUserId: m.bo, replyRealtime: false },
      { workspaceUserId: m.quin, newSubmissionRealtime: true, replyRealtime: false, assignedRealtime: false, digestFrequency: "off" },
    ]);

    const [acme] = await db.insert(accounts).values({ workspaceId: ws, name: "Acme" }).returning({ id: accounts.id });
    const [sample] = await db.insert(accounts)
      .values({ workspaceId: ws, name: "Sample Co", externalCrmId: SAMPLE_ACCOUNT_EXTERNAL_ID })
      .returning({ id: accounts.id });
    const [pat] = await db.insert(accountUsers)
      .values({ workspaceId: ws, accountId: acme.id, email: "pat@acme.test", name: "Pat", initials: "P" })
      .returning({ id: accountUsers.id });
    const [maya] = await db.insert(accountUsers)
      .values({ workspaceId: ws, accountId: sample.id, email: "maya@sample-co.invalid", name: "Maya", initials: "M" })
      .returning({ id: accountUsers.id });

    const specs: Array<Partial<typeof items.$inferInsert> & { by?: string; vendorLast?: boolean }> = [
      { assigneeId: m.pia },                                    // FB-1 waiting on the team, Pia's
      { assigneeId: m.quin },                                   // FB-2 waiting on the team
      { by: m.ada },                                            // FB-3 created by Ada
      { vendorLast: true },                                     // FB-4 answered: the customer's turn
      { status: "shipped" },                                    // FB-5 closed today
      { accountId: sample.id, submitterId: maya.id },           // FB-6 a sample
      { assigneeId: m.quin, externalProvider: "linear", externalTicketId: "ENG-7" }, // FB-7
      { assigneeId: m.pia, status: "shipped", externalProvider: "jira", externalTicketId: "ENG-8" }, // FB-8
    ];
    for (const [i, { by, vendorLast, ...spec }] of specs.entries()) {
      const n = i + 1;
      const [row] = await db.insert(items).values({
        workspaceId: ws, accountId: acme.id, submitterId: pat.id,
        seq: n, shortId: `FB-${n}`, title: `Item ${n}`, type: "bug", ...spec,
      }).returning({ id: items.id });
      fb[n] = row.id;
      await db.insert(statusEvents).values({ itemId: row.id, fromStatus: null, toStatus: "open", byWorkspaceUserId: by ?? null });
      if (spec.status === "shipped") await db.insert(statusEvents).values({ itemId: row.id, fromStatus: "open", toStatus: "shipped" });
      await db.insert(replies).values(vendorLast
        ? { itemId: row.id, workspaceUserId: m.ada, body: "Fixed, can you confirm?" }
        : { itemId: row.id, accountUserId: spec.submitterId ?? pat.id, body: "Please help." });
    }
    sent.length = 0;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!ws) return;
    await db.delete(items).where(eq(items.workspaceId, ws));
    await db.delete(workspaces).where(eq(workspaces.id, ws));
  });

  it("a customer reply reaches the assignee, or the admins when the assignee won't get it", async () => {
    await notifyVendorsOfCustomerReply({ itemId: fb[1], customerName: "Pat", replyBody: "Any news?", dashboardOrigin: APP });
    expect(recipients()).toEqual(["pia@vendor.test"]);
    // Quin muted replies, so the admins hear it; Bo muted them too.
    await notifyVendorsOfCustomerReply({ itemId: fb[2], customerName: "Pat", replyBody: "Any news?", dashboardOrigin: APP });
    expect(recipients()).toEqual(["ada@vendor.test"]);
  });

  it("a new submission reaches admins by default and members who chose it, never its creator", async () => {
    await notifyNewSubmission({ workspaceId: ws, itemId: fb[1] });
    const mail = sent.slice();
    expect(recipients()).toEqual(["ada@vendor.test", "bo@vendor.test", "quin@vendor.test"]);
    expect(mail[0].subject).toBe("New feedback · FB-1 Item 1");
    expect(mail[0].from).not.toContain("via Crumb");
    expect(mail[0].text).toContain(`${APP}/thread/FB-1`);

    await notifyNewSubmission({ workspaceId: ws, itemId: fb[3] });
    expect(recipients()).toEqual(["bo@vendor.test", "quin@vendor.test"]);
  });

  it("an assignment tells the assignee only, and never about their own action", async () => {
    await notifyAssigned({ workspaceId: ws, itemId: fb[4], assigneeId: m.pia, actorWorkspaceUserId: m.ada });
    const [mail] = sent;
    expect(recipients()).toEqual(["pia@vendor.test"]);
    expect(mail.text).toContain("Ada assigned FB-4 to you");

    await notifyAssigned({ workspaceId: ws, itemId: fb[4], assigneeId: m.ada, actorWorkspaceUserId: m.ada });
    await notifyAssigned({ workspaceId: ws, itemId: fb[4], assigneeId: m.quin, actorWorkspaceUserId: m.ada });
    expect(recipients()).toEqual([]);
  });

  it("a bulk assignment sends the assignee one list, not one alert per item", async () => {
    await notifyAssignedMany({ workspaceId: ws, itemIds: [fb[1], fb[2], fb[3]], assigneeId: m.pia, actorWorkspaceUserId: m.ada });
    const [mail] = sent;
    expect(recipients()).toEqual(["pia@vendor.test"]);
    expect(mail.subject).toBe("Assigned to you · 3 requests");
    expect(mail.text).toContain("Ada assigned 3 requests to you");
    expect(mail.text).toContain("Assigned to you (3)\n- FB-3 Item 3");
    expect(mail.text).toContain(`${APP}/thread/FB-1`);

    // Quin muted assignment alerts; nobody hears about their own action.
    await notifyAssignedMany({ workspaceId: ws, itemIds: [fb[1], fb[2]], assigneeId: m.quin, actorWorkspaceUserId: m.ada });
    await notifyAssignedMany({ workspaceId: ws, itemIds: [fb[1], fb[2]], assigneeId: m.ada, actorWorkspaceUserId: m.ada });
    expect(recipients()).toEqual([]);
  });

  it("a tracker reaching done on an open loop tells someone to close it", async () => {
    // Quin muted assignment alerts, so FB-7's goes to the admins.
    await syncExternalStatus(eq(items.id, fb[7]), "Done");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const [mail] = sent;
    expect(recipients()).toEqual(["ada@vendor.test", "bo@vendor.test"]);
    expect(mail.subject).toBe("Linear marked FB-7 done. Tell the customer.");

    await syncExternalStatus(eq(items.id, fb[7]), "Closed");    // done to done, like Jira's Resolved to Closed
    await syncExternalStatus(eq(items.id, fb[7]), "In Review"); // not a done state
    await syncExternalStatus(eq(items.id, fb[8]), "Done");      // the loop is already closed
    await settle();
    expect(recipients()).toEqual([]);
  });

  it("the digest goes once per period, with the watermark set only after a send", async () => {
    const scope = eq(workspaceUsers.workspaceId, ws);
    const now = Date.now();
    // Overlapping runs: one sends, the other stands down.
    const [run, overlap] = await Promise.all([sendDigests(now, scope), sendDigests(now, scope)]);
    expect(run).toEqual({ due: 3, sent: 3, empty: 0, unsent: 0 }); // Quin's is off
    expect(overlap).toEqual({ busy: true });

    const mail = sent.splice(0);
    expect(mail.map(e => e.to).sort()).toEqual(["ada@vendor.test", "bo@vendor.test", "pia@vendor.test"]);
    const pia = mail.find(e => e.to === "pia@vendor.test")!;
    // FB-1, 2, 3 and 7 wait on the team; FB-4 waits on the customer, FB-6 is a sample.
    expect(pia.subject).toBe("4 loops waiting on your team · Vendor notify test");
    expect(pia.text).toContain("Waiting on your team (4)");
    expect(pia.text).toContain("Assigned to you and waiting (1)\n- FB-1 Item 1");
    expect(pia.text).toContain("New in the last day (7)");
    expect(pia.text).toContain("Closed in the last day (2)");
    expect(pia.text).toContain(`${APP}/thread/FB-1`);
    expect(pia.text).not.toContain("FB-6");
    expect(mail.find(e => e.to === "ada@vendor.test")!.text).not.toContain("Assigned to you");

    // Inside the period nothing more goes out.
    expect(await sendDigests(now + 3_600_000, scope)).toEqual({ due: 0, sent: 0, empty: 0, unsent: 0 });

    const rows = await db.select().from(notificationPreferences)
      .where(inArray(notificationPreferences.workspaceUserId, [m.ada, m.pia, m.quin]));
    const row = (id: string) => rows.find(r => r.workspaceUserId === id)!;
    expect(row(m.pia).lastDigestAt).toEqual(new Date(now));
    expect(row(m.quin).lastDigestAt).toBeNull();
    // Recording the watermark kept the defaults Ada and Pia had without a row.
    expect(row(m.ada).newSubmissionRealtime).toBe(true);
    expect(row(m.pia).newSubmissionRealtime).toBe(false);
  });
});
