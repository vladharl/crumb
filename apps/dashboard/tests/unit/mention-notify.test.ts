import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, notificationPreferences, workspaces, workspaceUsers } from "@crumb/db";
import { notifyMentioned } from "@/lib/mention-notify";

// A mention DM quotes the item title, which the customer wrote, in Slack
// mrkdwn. Unescaped, a title like `<https://evil.test|Reset your password>`
// lands in a teammate's DMs as a live link that reads like a Crumb prompt.
//
// Runs against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`) with
// Slack's Web API stubbed. Skipped locally when no database answers; CI has
// one, so there it fails instead.

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("mention DMs", () => {
  const sent: string[] = [];
  let workspaceId: string | null = null;

  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true });
    }));
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  it("render a crafted title and author name as inert text", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `mention-dm-${randomUUID().slice(0, 8)}`, name: "Mention DM test", slackBotToken: "xoxb-test" })
      .returning({ id: workspaces.id });
    workspaceId = ws.id;
    const [mia] = await db.insert(workspaceUsers)
      .values({ workspaceId: ws.id, email: "mia@vendor.test", name: "Mia", initials: "M", slackUserId: "UMIA" })
      .returning({ id: workspaceUsers.id });
    await db.insert(notificationPreferences).values({ workspaceUserId: mia.id, delivery: "slack" });

    await notifyMentioned({
      workspaceId: ws.id,
      itemShortId: "FB-1",
      itemTitle: "<https://evil.test|Reset your password>",
      noteBody: "Can you take this one?",
      byName: "<!channel> Sam",
      mentionedUserIds: [mia.id],
      dashboardOrigin: "https://crumb.example.test",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("_&lt;https://evil.test|Reset your password&gt;_");
    expect(sent[0]).toContain("*&lt;!channel&gt; Sam*");
    // Our own thread link is the only markup left.
    expect(sent[0].replace("<https://crumb.example.test/thread/FB-1|Open thread →>", "")).not.toMatch(/[<>]/);
  });
});
