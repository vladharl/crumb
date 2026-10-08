import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, workspaces, workspaceUsers } from "@crumb/db";
import { clearProviderInstall, disconnectNotice } from "@/lib/integrations/revoke";

// An automatic disconnect is never silent: it records why on the workspace
// (the Reconnect banner reads it back), emails each admin once even when a
// burst of failures all trip it, and drops Slack user ids cached against the
// old install.
//
// Runs against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`).
// Skipped locally when no database answers; CI has one, so there it fails.

const { sendIntegrationDisconnected } = vi.hoisted(() => ({
  sendIntegrationDisconnected: vi.fn(async (_m: { to: string }) => {}),
}));
vi.mock("@/lib/email", () => ({ sendIntegrationDisconnected }));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("automatic integration disconnects", () => {
  let workspaceId: string | null = null;

  beforeAll(() => vi.stubEnv("CRUMB_APP_URL", "https://crumb.example.test"));
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  it("record the reason, email each admin once and clear cached Slack ids", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `disconnect-${randomUUID().slice(0, 8)}`, name: "Acme", slackBotToken: "xoxb-test", slackTeamId: "T1" })
      .returning();
    workspaceId = ws.id;
    await db.insert(workspaceUsers).values([
      { workspaceId: ws.id, email: "ada@acme.test", name: "Ada", initials: "A", role: "admin", slackUserId: "UADA" },
      { workspaceId: ws.id, email: "bo@acme.test", name: "Bo", initials: "B", role: "admin" },
      { workspaceId: ws.id, email: "cy@acme.test", name: "Cy", initials: "C", role: "pm", slackUserId: "UCY" },
    ]);

    // Three DMs in one fan-out all hit token_revoked at once.
    await Promise.all([1, 2, 3].map(() => clearProviderInstall(ws.id, "slack")));

    const [after] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(after.slackBotToken).toBeNull();
    expect(after.integrationAlerts?.slack?.reason).toBe("revoked");

    expect(sendIntegrationDisconnected).toHaveBeenCalledTimes(2);
    expect(sendIntegrationDisconnected.mock.calls.map(([m]) => m.to).sort()).toEqual(["ada@acme.test", "bo@acme.test"]);
    expect(sendIntegrationDisconnected).toHaveBeenCalledWith(expect.objectContaining({
      workspaceName: "Acme",
      provider: "Slack",
      reconnectUrl: "https://crumb.example.test/settings/integrations",
    }));

    const users = await db.select({ slackUserId: workspaceUsers.slackUserId }).from(workspaceUsers).where(eq(workspaceUsers.workspaceId, ws.id));
    expect(users.every((u) => u.slackUserId === null)).toBe(true);

    const notice = disconnectNotice(after, "slack");
    expect(notice?.text).toMatch(/^Slack was disconnected on .+ Reconnect to turn it back on\.$/);
    expect(notice?.text).not.toMatch(/[—–]/);
    // Reconnected (by a callback that doesn't clear the alert): no stale banner.
    expect(disconnectNotice({ ...after, slackBotToken: "xoxb-new" }, "slack")).toBeNull();
  });
});
