import { afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, changelogEntries, initiatives, items, roadmapFollows, workspaces } from "@crumb/db";
import type { OutgoingEmail } from "@/lib/email/provider";

// Capture what lib/email hands the provider (stdout is picked when no provider is set).
const sent = vi.hoisted(() => [] as OutgoingEmail[]);
vi.mock("@/lib/email/stdout", () => ({
  stdoutProvider: {
    name: "stdout",
    send: async (m: OutgoingEmail) => { sent.push(m); return { ok: true as const, providerMessageId: null }; },
  },
}));

import { publishChangelogEntry } from "@/lib/changelog";
import { sendRoadmapUpdateNotification } from "@/lib/email";

// Publishing a shipped entry is the loop's last beat. Everyone who asked and
// everyone following gets the Shipped email (not a roadmap update), told why
// they're getting it, in the vendor's color, on the initiative's thread.
//
// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.
const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const created: string[] = [];

describe.skipIf(!reachable && !process.env.CI)("publishChangelogEntry", () => {
  afterAll(async () => {
    if (created.length === 0) return;
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("sends the Shipped email to askers and followers, asking winning over following", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `changelog-${randomUUID().slice(0, 8)}`, name: "Acme", accent: "#3366FF" })
      .returning();
    created.push(ws!.id);
    const [acct] = await db.insert(accounts).values({ workspaceId: ws!.id, name: "Initech" }).returning({ id: accounts.id });
    const [asker, fan] = await db.insert(accountUsers).values([
      { workspaceId: ws!.id, accountId: acct!.id, email: "asker@initech.test", name: "Ann", initials: "A" },
      { workspaceId: ws!.id, accountId: acct!.id, email: "fan@initech.test", name: "Fay", initials: "F" },
    ]).returning({ id: accountUsers.id });
    const [ini] = await db.insert(initiatives)
      .values({ workspaceId: ws!.id, seq: 1, shortId: "IN-1", name: "Dark mode" })
      .returning({ id: initiatives.id });
    await db.insert(items).values({
      workspaceId: ws!.id, accountId: acct!.id, submitterId: asker!.id, initiativeId: ini!.id,
      seq: 1, shortId: "FB-1", title: "Dark theme please", type: "idea",
    });
    // The asker follows too, and still hears it as the one who asked.
    await db.insert(roadmapFollows).values([
      { workspaceId: ws!.id, initiativeId: ini!.id, accountUserId: asker!.id },
      { workspaceId: ws!.id, initiativeId: ini!.id, accountUserId: fan!.id },
    ]);
    const [entry] = await db.insert(changelogEntries)
      .values({ workspaceId: ws!.id, initiativeId: ini!.id, title: "Dark mode is here", body: "Find it under Settings." })
      .returning({ id: changelogEntries.id });

    // stdout never counts as delivered, so nothing is reported sent.
    expect(await publishChangelogEntry(ws!, entry!.id)).toEqual({
      ok: true, announced: true, delivered: 0, failed: 0, followers: 0, emailOn: false, marked: 0,
      skipped: { count: 0, sources: [], noEmail: false, muted: false },
    });
    const mail = Object.fromEntries(sent.map(m => [m.to, m]));
    expect(Object.keys(mail).sort()).toEqual(["asker@initech.test", "fan@initech.test"]);
    for (const m of sent) {
      expect(m.subject).toBe("Shipped: Dark mode is here");
      expect(m.html).toContain("color:#3366FF");
    }
    expect(mail["asker@initech.test"]!.text).toContain("because you asked Acme for this.");
    expect(mail["fan@initech.test"]!.text).toContain("because you follow this on Acme's roadmap.");

    // Threads with the initiative's roadmap moves, keyed on its name.
    await sendRoadmapUpdateNotification({ to: "fan@initech.test", workspaceName: "Acme", initiativeName: "Dark mode", change: "moved to Now" });
    expect(sent.at(-1)!.headers!["In-Reply-To"]).toBe(mail["fan@initech.test"]!.headers!["In-Reply-To"]);
  });
});
