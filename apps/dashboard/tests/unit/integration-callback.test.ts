import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as githubCallback } from "@/app/api/integrations/github/callback/route";
import { GET as hubspotCallback } from "@/app/api/integrations/hubspot/callback/route";
import { GET as jiraCallback } from "@/app/api/integrations/jira/callback/route";
import { GET as linearCallback } from "@/app/api/integrations/linear/callback/route";
import { GET as salesforceCallback } from "@/app/api/integrations/salesforce/callback/route";
import { GET as slackCallback } from "@/app/api/integrations/slack/callback/route";
import { verifyCallback } from "@/lib/integrations/callback";
import { signState, type Provider } from "@/lib/integrations/state";

// An integration callback may only finish for the signed-in admin of the
// workspace its state was issued for. Otherwise an attacker sends a victim
// admin a consent link carrying the attacker's own state, and the victim's
// HubSpot/Slack/... is bound to the attacker's workspace. Every refusal here
// happens before the database or the provider is touched, so these run the
// real route handlers with only the session mocked.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSession }));

const APP = "https://crumb.example.test";
const WS = "f20454c8-62f5-4325-9bf2-b65933d18b46";
const OTHER_WS = "0b6f7c2e-9a51-4d8e-8f3a-2c1d5e7a9b10";
const fetchSpy = vi.fn();

const routes: Array<[Provider, (req: Request) => Promise<Response>, string]> = [
  ["github", githubCallback, "installation_id=42&setup_action=install"],
  ["hubspot", hubspotCallback, "code=c"],
  ["jira", jiraCallback, "code=c"],
  ["linear", linearCallback, "code=c"],
  ["salesforce", salesforceCallback, "code=c"],
  ["slack", slackCallback, "code=c"],
];

// req.url is the internal service address behind the Cloudflare Tunnel.
function callbackReq(provider: Provider, query: string): Request {
  return new Request(`http://0.0.0.0:3000/api/integrations/${provider}/callback?${query}`);
}

function sessionFor(workspaceId: string, role = "admin") {
  return { workspace: { id: workspaceId }, user: { id: "user-1", role } };
}

describe("integration callbacks", () => {
  beforeAll(() => {
    vi.stubEnv("CRUMB_APP_URL", APP);
    vi.stubEnv("CRUMB_OAUTH_STATE_SECRET", "test-state-secret");
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  beforeEach(() => {
    getSession.mockReset();
    fetchSpy.mockClear();
  });

  it.each(routes)("%s: only the state's own signed-in workspace can finish, on the public origin", async (provider, GET, query) => {
    const withState = `${query}&state=${signState(provider, WS)}`;
    const settings = `${APP}/settings/integrations?${provider}=`;

    expect((await GET(callbackReq(provider, ""))).headers.get("location")).toBe(`${settings}error_missing_params`);

    getSession.mockResolvedValue(null);
    expect((await GET(callbackReq(provider, withState))).headers.get("location")).toBe(`${APP}/login`);

    getSession.mockResolvedValue(sessionFor(OTHER_WS));
    expect((await GET(callbackReq(provider, withState))).headers.get("location")).toBe(`${settings}error_wrong_workspace`);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("verifyCallback passes the workspace's admin only, and only within the state's lifetime", async () => {
    const req = callbackReq("hubspot", "");
    const settings = `${APP}/settings/integrations?hubspot=`;

    getSession.mockResolvedValue(sessionFor(WS));
    expect(await verifyCallback(req, "hubspot", signState("hubspot", WS)))
      .toEqual({ ok: true, workspaceId: WS, userId: "user-1" });

    const wrongProvider = await verifyCallback(req, "hubspot", signState("salesforce", WS));
    expect(!wrongProvider.ok && wrongProvider.redirect.headers.get("location")).toBe(`${settings}error_bad_state`);

    vi.useFakeTimers();
    const stale = signState("hubspot", WS);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    const expired = await verifyCallback(req, "hubspot", stale);
    expect(!expired.ok && expired.redirect.headers.get("location")).toBe(`${settings}error_bad_state`);
    vi.useRealTimers();

    getSession.mockResolvedValue(sessionFor(WS, "pm"));
    const member = await verifyCallback(req, "hubspot", signState("hubspot", WS));
    expect(!member.ok && member.redirect.headers.get("location")).toBe(`${settings}error_forbidden`);
  });
});
