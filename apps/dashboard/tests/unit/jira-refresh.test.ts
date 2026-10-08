import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { refreshToken } from "@/lib/integrations/jira";
import { IntegrationAuthError } from "@/lib/integrations/revoke";

// A Jira token refresh disconnects only when Atlassian rejects the refresh
// token itself (invalid_grant). A rejected client secret fails every install's
// refresh at once, and the daily sweep refreshes nearly all of them, so
// disconnecting on that would drop every install and email every admin.
//
// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.

vi.mock("@/lib/email", () => ({ sendIntegrationDisconnected: vi.fn(async () => {}) }));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("jira token refresh", () => {
  let wsId: string | null = null;

  beforeEach(() => {
    vi.stubEnv("JIRA_CLIENT_ID", "jira-id");
    vi.stubEnv("JIRA_CLIENT_SECRET", "jira-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    if (wsId) await db.delete(workspaces).where(eq(workspaces.id, wsId));
  });

  it("disconnects on invalid_grant only, whatever the status", async () => {
    const [ws] = await db.insert(workspaces).values({
      slug: `jira-refresh-${randomUUID().slice(0, 8)}`, name: "Jira refresh test",
      jiraAccessToken: "at", jiraRefreshToken: "rt", jiraCloudId: "cloud-1",
      jiraSiteUrl: "https://acme.atlassian.net", jiraInstalledAt: new Date(),
    }).returning({ id: workspaces.id });
    wsId = ws.id;
    const answer = (body: unknown, status: number) =>
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));
    const install = async () => (await db.select().from(workspaces).where(eq(workspaces.id, ws.id)))[0];

    // A rotated or mistyped client secret: Atlassian rejects the client, not the token.
    answer({ error: "access_denied", error_description: "Unauthorized" }, 401);
    await expect(refreshToken(ws.id, "rt", "cloud-1")).rejects.toThrow(/^jira_refresh_failed: 401/);
    answer({ error: "invalid_client" }, 400);
    await expect(refreshToken(ws.id, "rt", "cloud-1")).rejects.toThrow(/^jira_refresh_failed: 400/);
    expect((await install()).jiraAccessToken).toBe("at");

    // The refresh token itself is dead (Atlassian answers 403).
    answer({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, 403);
    await expect(refreshToken(ws.id, "rt", "cloud-1")).rejects.toBeInstanceOf(IntegrationAuthError);
    const after = await install();
    expect(after.jiraAccessToken).toBeNull();
    expect(after.integrationAlerts?.jira?.reason).toBe("revoked");
  });
});
