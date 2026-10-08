import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db, accounts, workspaces, workspaceUsers } from "@crumb/db";
import { GET as slackCallback } from "@/app/api/integrations/slack/callback/route";
import { POST as slackCommands } from "@/app/api/integrations/slack/commands/route";
import { POST as slackEvents } from "@/app/api/integrations/slack/events/route";
import { POST as slackInteractivity } from "@/app/api/integrations/slack/interactivity/route";
import { signState } from "@/lib/integrations/state";
import { clearProviderInstall } from "@/lib/integrations/revoke";
import { workspaceForSlackTeam } from "@/lib/slack/install";

// Slack tenancy. The events, commands and interactivity routes find their
// Crumb workspace by Slack team id, so a team belongs to one workspace at most.
// What they show (the @mention sizing bot's requester ARR and other accounts'
// request titles, /crumb's customer list) is for this workspace's teammates
// only, and the sizing only privately: any channel can hold a guest, and a
// Slack Connect one the customer.
//
// Runs the real route handlers against Postgres (DATABASE_URL, migrated via
// `pnpm db:migrate`), with the session, item creation and Slack's Web API
// stubbed. Skipped locally when no database answers; CI has one, so there it
// fails instead.

const { getSession, composeItem } = vi.hoisted(() => ({
  getSession: vi.fn(),
  composeItem: vi.fn(async (_input: { workspaceId: string; actorWorkspaceUserId?: string | null }) => ({ ok: true as const })),
}));
vi.mock("@/lib/auth", () => ({ getSession }));
vi.mock("@/lib/compose", () => ({ composeItem }));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

const APP = "https://crumb.example.test";
const SIGNING_SECRET = "test-slack-signing";
const tag = randomUUID().slice(0, 8);
const CLAIMED_TEAM = `T-claimed-${tag}`;
const SHARED_TEAM = `T-shared-${tag}`;
const MENTION_TEAM = `T-mention-${tag}`;
const REVOKED_TEAM = `T-revoked-${tag}`;
const COMMAND_TEAM = `T-command-${tag}`;
const created: string[] = [];
let installTeam = CLAIMED_TEAM; // the team the OAuth exchange installs

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

// Slack's Web API: the OAuth exchange installs `installTeam`, users.info answers
// from `emails`, chat.postMessage, chat.postEphemeral and views.open are
// recorded. Anything else is unexpected.
const emails: Record<string, string> = {};
const lookedUp: string[] = [];
const posts: Array<{ thread_ts?: string; text: string; blocks?: unknown }> = [];
const ephemeral: Array<{ channel: string; user: string; thread_ts?: string; text: string; blocks?: unknown }> = [];
const views: unknown[] = [];
const slackApi = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.pathname === "/api/oauth.v2.access") {
    return Response.json({ ok: true, app_id: "A1", team: { id: installTeam, name: "Acme" }, access_token: "xoxb-new", bot_user_id: "UBOT", scope: "" });
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
  if (url.pathname === "/api/views.open") {
    views.push(JSON.parse(String(init?.body)).view);
    return Response.json({ ok: true });
  }
  throw new Error(`unexpected fetch: ${url}`);
});

// Finish a Slack install as the signed-in admin of `workspaceId`.
const settings = `${APP}/settings/integrations?slack=`;
function finishInstall(workspaceId: string) {
  getSession.mockResolvedValue({ workspace: { id: workspaceId }, user: { id: "user-1", role: "admin" } });
  const state = signState("slack", workspaceId);
  return slackCallback(new Request(`http://0.0.0.0:3000/api/integrations/slack/callback?code=c&state=${state}`));
}

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

    expect((await finishInstall(other)).headers.get("location")).toBe(`${settings}error_team_already_connected`);
    expect(await teamOf(other)).toBeNull();

    expect((await finishInstall(holder)).headers.get("location")).toBe(`${settings}connected`);
    expect(await teamOf(holder)).toBe(CLAIMED_TEAM);
  });

  it("a workspace whose Slack install was revoked no longer holds its team", async () => {
    installTeam = REVOKED_TEAM;
    // Revoked the way the notifiers clear a dead token: the team id goes too.
    const revoked = await workspace({ slackTeamId: REVOKED_TEAM, slackBotToken: "xoxb-dead", slackBotUserId: "UBOT" });
    await clearProviderInstall(revoked, "slack");
    expect(await teamOf(revoked)).toBeNull();
    // A row from before that, left with the team id and no token, holds nothing either.
    await workspace({ slackTeamId: REVOKED_TEAM });
    const next = await workspace();

    expect((await finishInstall(next)).headers.get("location")).toBe(`${settings}connected`);
    expect(await teamOf(next)).toBe(REVOKED_TEAM);
    expect((await workspaceForSlackTeam(REVOKED_TEAM))?.id).toBe(next);
    installTeam = CLAIMED_TEAM;
  });

  it("reconnecting to another Slack team drops the old team's cached user ids; the same team keeps them", async () => {
    const oldTeam = `T-old-${tag}`;
    const ws = await workspace({ slackTeamId: oldTeam, slackBotToken: "xoxb-old", slackBotUserId: "UBOT" });
    await db.insert(workspaceUsers).values([
      { workspaceId: ws, email: "mia@vendor.test", name: "Mia", initials: "M", slackUserId: "UOLDMIA" },
      { workspaceId: ws, email: "sam@vendor.test", name: "Sam", initials: "S", slackLookupFailedAt: new Date() },
    ]);
    const cached = () => db
      .select({ id: workspaceUsers.slackUserId, failed: sql<boolean>`${workspaceUsers.slackLookupFailedAt} IS NOT NULL` })
      .from(workspaceUsers)
      .where(eq(workspaceUsers.workspaceId, ws))
      .orderBy(asc(workspaceUsers.email));

    installTeam = oldTeam;
    expect((await finishInstall(ws)).headers.get("location")).toBe(`${settings}connected`);
    expect(await cached()).toEqual([{ id: "UOLDMIA", failed: false }, { id: null, failed: true }]);

    // A DM to UOLDMIA with the new team's token would fail forever, and Sam's
    // failed lookup was against the old team.
    installTeam = `T-new-${tag}`;
    expect((await finishInstall(ws)).headers.get("location")).toBe(`${settings}connected`);
    expect(await cached()).toEqual([{ id: null, failed: false }, { id: null, failed: false }]);
    installTeam = CLAIMED_TEAM;
  });

  it("a team still held by two workspaces (from before that guard) routes nowhere", async () => {
    await workspace({ slackTeamId: SHARED_TEAM, slackBotToken: "xoxb-a" });
    await workspace({ slackTeamId: SHARED_TEAM, slackBotToken: "xoxb-b" });

    const res = await slackCommands(fromSlack("commands", `team_id=${SHARED_TEAM}&trigger_id=t1&user_id=U1&command=%2Fcrumb`, "application/x-www-form-urlencoded"));
    expect(await res.json()).toMatchObject({ text: "This Slack workspace isn't connected to Crumb yet." });
  });

  it("/crumb shows the customer list and logs feedback for teammates only, crediting one Crumb never DMed", async () => {
    const ws = await workspace({ slackTeamId: COMMAND_TEAM, slackBotToken: "xoxb-test", slackBotUserId: "UBOT" });
    await db.insert(accounts).values({ workspaceId: ws, name: "Globex" });
    const [kai] = await db.insert(workspaceUsers)
      .values({ workspaceId: ws, email: "kai@vendor.test", name: "Kai", initials: "K" })
      .returning({ id: workspaceUsers.id });
    Object.assign(emails, {
      UGUEST: "guest@customer.test", // a guest (or a member) of the Slack team, not in Crumb
      UKAI: "Kai@Vendor.test",       // the teammate, never DMed: no cached Slack id
    });

    const command = (user: string) => slackCommands(fromSlack(
      "commands", `team_id=${COMMAND_TEAM}&trigger_id=t-${user}&user_id=${user}&command=%2Fcrumb`, "application/x-www-form-urlencoded",
    ));
    expect(await (await command("UGUEST")).json())
      .toEqual({ response_type: "ephemeral", text: "Only teammates in this Crumb workspace can use /crumb." });
    expect(views).toHaveLength(0);
    expect((await command("UKAI")).status).toBe(200);
    expect(JSON.stringify(views)).toContain("Globex");

    const submit = (user: string) => slackInteractivity(fromSlack("interactivity", `payload=${encodeURIComponent(JSON.stringify({
      type: "view_submission",
      team: { id: COMMAND_TEAM },
      user: { id: user, username: user.toLowerCase(), team_id: COMMAND_TEAM },
      view: { state: { values: { account: { v: { value: "Globex" } }, title: { v: { value: "SSO" } } } } },
    }))}`, "application/x-www-form-urlencoded"));
    expect(await (await submit("UGUEST")).json()).toMatchObject({ response_action: "errors" });
    expect(composeItem).not.toHaveBeenCalled();

    // Matched by Slack email: the item is Kai's Trail entry (and no alert to
    // Kai), and Kai's Slack id is cached for DMs.
    expect(await (await submit("UKAI")).json()).toEqual({ response_action: "clear" });
    expect(composeItem).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: ws, actorWorkspaceUserId: kai.id }));
    const [row] = await db.select({ slackUserId: workspaceUsers.slackUserId }).from(workspaceUsers).where(eq(workspaceUsers.id, kai.id));
    expect(row.slackUserId).toBe("UKAI");
  });

  it("the @mention sizing bot answers teammates only, and every reply privately", async () => {
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
    await vi.waitFor(() => expect(ephemeral).toHaveLength(3), { timeout: 5000 });

    // Even in an ordinary channel nothing is posted for everyone: a guest
    // there would read the sizing. Top-level mentions are answered in the
    // channel, visible to the mentioner alone.
    expect(posts).toHaveLength(0);
    const replyTo = (user: string) => ephemeral.find(p => p.user === user);
    for (const refused of ["UCUSTOMER", "USTRANGER"]) {
      expect(replyTo(refused)).toMatchObject({ channel: "C1", text: "Request sizing is only available to members of this Crumb workspace." });
      expect(replyTo(refused)?.blocks).toBeUndefined();
    }
    expect(replyTo("UMIA")).toMatchObject({ channel: "C1", text: expect.stringMatching(/^Mention me on a message/) });
    // A foreign team's user is turned away before Slack is asked who they are.
    expect(lookedUp).not.toContain("UCUSTOMER");

    // A mention inside a thread (here in a Slack Connect channel) is answered
    // privately in that thread.
    await slackEvents(fromSlack("events", JSON.stringify({
      type: "event_callback",
      team_id: MENTION_TEAM,
      is_ext_shared_channel: true,
      event: { type: "app_mention", user: "UMIA", user_team: MENTION_TEAM, team: MENTION_TEAM, text: "<@UBOT>", channel: "C2", ts: "2.2", thread_ts: "2.1" },
    }), "application/json"));
    await vi.waitFor(() => expect(ephemeral).toHaveLength(4), { timeout: 5000 });
    expect(ephemeral[3]).toMatchObject({ channel: "C2", user: "UMIA", thread_ts: "2.1", text: expect.stringMatching(/^Mention me on a message/) });
    expect(posts).toHaveLength(0);
  });
});
