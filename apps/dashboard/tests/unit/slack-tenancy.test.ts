import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, workspaces, workspaceUsers } from "@crumb/db";
import { GET as slackCallback } from "@/app/api/integrations/slack/callback/route";
import { POST as slackCommands } from "@/app/api/integrations/slack/commands/route";
import { POST as slackEvents } from "@/app/api/integrations/slack/events/route";
import { signState } from "@/lib/integrations/state";

// Slack tenancy. The events, commands and interactivity routes find their
// Crumb workspace by Slack team id, so a team belongs to one workspace at most.
// And the @mention sizing bot's reply carries requester ARR and other accounts'
// request titles, so it answers only teammates (in a Slack Connect channel the
// person mentioning it can be the customer), and there only privately.
//
// Runs the real route handlers against Postgres (DATABASE_URL, migrated via
// `pnpm db:migrate`), with the session and Slack's Web API stubbed. Skipped
// locally when no database answers; CI has one, so there it fails instead.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSession }));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

const APP = "https://crumb.example.test";
const SIGNING_SECRET = "test-slack-signing";
const tag = randomUUID().slice(0, 8);
const CLAIMED_TEAM = `T-claimed-${tag}`;
const SHARED_TEAM = `T-shared-${tag}`;
const MENTION_TEAM = `T-mention-${tag}`;
const created: string[] = [];

async function workspace(cols: Partial<typeof workspaces.$inferInsert> = {}) {
  const [ws] = await db.insert(workspaces)
    .values({ slug: `slack-tenancy-${tag}-${created.length}`, name: "Slack tenancy test", ...cols })
    .returning({ id: workspaces.id });
  created.push(ws.id);
  return ws.id;
}

async function teamOf(workspaceId: string) {
  const [row] = await db.select({ team: workspaces.slackTeamId }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return row.team;
}

// A request signed the way Slack signs one (lib/slack/verify).
function fromSlack(path: string, body: string, contentType: string): Request {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request(`http://0.0.0.0:3000/api/integrations/slack/${path}`, {
    method: "POST",
    headers: { "content-type": contentType, "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body,
  });
}

// Slack's Web API: the OAuth exchange installs CLAIMED_TEAM, users.info answers
// from `emails`, chat.postMessage and chat.postEphemeral are recorded. Anything
// else is unexpected.
const emails: Record<string, string> = {};
const lookedUp: string[] = [];
const posts: Array<{ thread_ts?: string; text: string; blocks?: unknown }> = [];
const ephemeral: Array<{ channel: string; user: string; thread_ts?: string; text: string }> = [];
const slackApi = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.pathname === "/api/oauth.v2.access") {
    return Response.json({ ok: true, app_id: "A1", team: { id: CLAIMED_TEAM, name: "Acme" }, access_token: "xoxb-new", bot_user_id: "UBOT", scope: "" });
  }
  if (url.pathname === "/api/users.info") {
    const user = url.searchParams.get("user") ?? "";
    lookedUp.push(user);
    return Response.json({ ok: true, user: { profile: { email: emails[user] } } });
  }
  if (url.pathname === "/api/chat.postMessage") {
    posts.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/chat.postEphemeral") {
    ephemeral.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }
  throw new Error(`unexpected fetch: ${url}`);
});

describe.skipIf(!reachable && !process.env.CI)("slack tenancy", () => {
  beforeAll(() => {
    vi.stubEnv("CRUMB_APP_URL", APP);
    vi.stubEnv("CRUMB_OAUTH_STATE_SECRET", "test-state-secret");
    vi.stubEnv("SLACK_CLIENT_ID", "test-client-id");
    vi.stubEnv("SLACK_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
    vi.stubGlobal("fetch", slackApi);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (created.length > 0) await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("a second workspace cannot claim a Slack team another one holds; the holder can reconnect", async () => {
    const holder = await workspace({ slackTeamId: CLAIMED_TEAM, slackBotToken: "xoxb-old", slackBotUserId: "UBOT" });
    const other = await workspace();
    const finishInstall = (workspaceId: string) => {
      getSession.mockResolvedValue({ workspace: { id: workspaceId }, user: { id: "user-1", role: "admin" } });
      const state = signState("slack", workspaceId);
      return slackCallback(new Request(`http://0.0.0.0:3000/api/integrations/slack/callback?code=c&state=${state}`));
    };
    const settings = `${APP}/settings/integrations?slack=`;

    expect((await finishInstall(other)).headers.get("location")).toBe(`${settings}error_team_already_connected`);
    expect(await teamOf(other)).toBeNull();

    expect((await finishInstall(holder)).headers.get("location")).toBe(`${settings}connected`);
    expect(await teamOf(holder)).toBe(CLAIMED_TEAM);
  });

  it("a team still held by two workspaces (from before that guard) routes nowhere", async () => {
    await workspace({ slackTeamId: SHARED_TEAM, slackBotToken: "xoxb-a" });
    await workspace({ slackTeamId: SHARED_TEAM, slackBotToken: "xoxb-b" });

    const res = await slackCommands(fromSlack("commands", `team_id=${SHARED_TEAM}&trigger_id=t1&user_id=U1&command=%2Fcrumb`, "application/x-www-form-urlencoded"));
    expect(await res.json()).toMatchObject({ text: "This Slack workspace isn't connected to Crumb yet." });
  });

  it("the @mention sizing bot gives a foreign-team or non-member mention no data", async () => {
    const ws = await workspace({ slackTeamId: MENTION_TEAM, slackBotToken: "xoxb-test", slackBotUserId: "UBOT" });
    await db.insert(workspaceUsers).values({ workspaceId: ws, email: "mia@vendor.test", name: "Mia", initials: "M" });
    Object.assign(emails, {
      UCUSTOMER: "mia@vendor.test", // another org's user, even one carrying a teammate's email
      USTRANGER: "sam@vendor.test", // in the installing team, not in Crumb
      UMIA: "Mia@Vendor.test",      // the teammate
    });
    const mention = (user: string, userTeam: string, ts: string, text: string) =>
      slackEvents(fromSlack("events", JSON.stringify({
        type: "event_callback",
        team_id: MENTION_TEAM,
        event: { type: "app_mention", user, user_team: userTeam, team: userTeam, text, channel: "C1", ts },
      }), "application/json"));

    await mention("UCUSTOMER", `T-customer-${tag}`, "1.1", "<@UBOT> we need SSO");
    await mention("USTRANGER", MENTION_TEAM, "1.2", "<@UBOT> Acme needs SSO");
    // The teammate gets past the gate: an empty mention earns the usage hint.
    await mention("UMIA", MENTION_TEAM, "1.3", "<@UBOT>");
    await vi.waitFor(() => expect(posts).toHaveLength(3), { timeout: 5000 });

    const replyTo = (ts: string) => posts.find(p => p.thread_ts === ts);
    for (const refused of ["1.1", "1.2"]) {
      expect(replyTo(refused)?.text).toBe("Request sizing is only available to members of this Crumb workspace.");
      expect(replyTo(refused)?.blocks).toBeUndefined();
    }
    expect(replyTo("1.3")?.text).toMatch(/^Mention me on a message/);
    // A foreign team's user is turned away before Slack is asked who they are.
    expect(lookedUp).not.toContain("UCUSTOMER");

    // In a Slack Connect channel the customer reads along, so even a teammate's
    // mention gets its reply privately, never in the channel.
    const before = posts.length;
    await slackEvents(fromSlack("events", JSON.stringify({
      type: "event_callback",
      team_id: MENTION_TEAM,
      is_ext_shared_channel: true,
      event: { type: "app_mention", user: "UMIA", user_team: MENTION_TEAM, team: MENTION_TEAM, text: "<@UBOT>", channel: "C2", ts: "2.2", thread_ts: "2.1" },
    }), "application/json"));
    await vi.waitFor(() => expect(ephemeral).toHaveLength(1), { timeout: 5000 });
    expect(ephemeral[0]).toMatchObject({ channel: "C2", user: "UMIA", thread_ts: "2.1", text: expect.stringMatching(/^Mention me on a message/) });
    expect(posts).toHaveLength(before);
  });
});
