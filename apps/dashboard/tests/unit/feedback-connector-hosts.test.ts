import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@crumb/db";
import { zendesk } from "@/lib/integrations/feedback/zendesk";
import { freshdesk } from "@/lib/integrations/feedback/freshdesk";
import { freshchat } from "@/lib/integrations/feedback/freshchat";
import { gong } from "@/lib/integrations/feedback/gong";
import type { ConnectionConfig, FeedbackAdapter } from "@/lib/integrations/feedback/types";

// The feedback connectors send the workspace's vendor credentials to a host
// built from admin-typed config, so that config must not be able to choose the
// host: a "subdomain" like evil.com/x? or a base URL off the vendor's API
// domain is refused before anything is fetched, and the real vendor hosts are
// fetched with redirects off. Creds are plaintext here (open() passes non-"enc:"
// values through).

function conn(config: ConnectionConfig): IntegrationConnection {
  return { accessToken: "tok", refreshToken: "secret", config, workspaceId: "ws-1" } as unknown as IntegrationConnection;
}

function stubFetch() {
  const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => [] }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("feedback connectors pin their vendor hosts", () => {
  it("refuses config that would aim the request off the vendor's domain, without fetching", async () => {
    const fetchMock = stubFetch();
    const cases: Array<[FeedbackAdapter, ConnectionConfig]> = [
      ...["evil.com/x?", "evil.com#", "127.0.0.1:8080/", "acme.zendesk.com@evil.com", "-acme", "a".repeat(64)]
        .map((subdomain): [FeedbackAdapter, ConnectionConfig] => [zendesk, { subdomain, email: "agent@acme.com" }]),
      [freshdesk, { domain: "169.254.169.254/latest/meta-data?" }],
      ...["https://169.254.169.254/v2", "http://acme.freshchat.com/v2", "https://freshchat.com.evil.com/v2", "https://acme.freshchat.com:8443/v2"]
        .map((baseUrl): [FeedbackAdapter, ConnectionConfig] => [freshchat, { baseUrl }]),
      ...["https://evil.com", "https://api.gong.io.evil.com", "http://api.gong.io", "https://10.0.0.1"]
        .map((baseUrl): [FeedbackAdapter, ConnectionConfig] => [gong, { baseUrl }]),
    ];
    for (const [adapter, cfg] of cases) {
      await expect(adapter.listSince(conn(cfg), null), `${adapter.provider} ${JSON.stringify(cfg)}`).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still reaches the real vendor hosts, with redirects off", async () => {
    const fetchMock = stubFetch();
    await zendesk.listSince(conn({ subdomain: " Acme ", email: "agent@acme.com" }), null);
    await freshdesk.listSince(conn({ domain: "acme" }), null);
    await freshchat.listSince(conn({ baseUrl: "https://acme.freshchat.com/v2/" }), null);
    await gong.listSince(conn({ baseUrl: "https://us-12345.api.gong.io" }), null);

    const calls = fetchMock.mock.calls;
    expect(calls.map(([url]) => new URL(String(url)).host)).toEqual([
      "acme.zendesk.com", "acme.freshdesk.com", "acme.freshchat.com", "us-12345.api.gong.io",
    ]);
    expect(calls.map(([, init]) => init?.redirect)).toEqual(["manual", "manual", "manual", "manual"]);
  });
});
