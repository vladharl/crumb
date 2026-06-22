import { describe, it, expect, vi, afterEach } from "vitest";
import { zendesk } from "@/lib/integrations/feedback/zendesk";
import type { IntegrationConnection } from "@crumb/db";

// A minimal connection. accessToken is plaintext here — open() returns non-"enc:"
// values unchanged, so no encryption key is needed in the test.
function conn(): IntegrationConnection {
  return {
    accessToken: "api-token-123",
    config: { subdomain: "acme", email: "agent@acme.com" },
    workspaceId: "ws-1",
  } as unknown as IntegrationConnection;
}

afterEach(() => vi.unstubAllGlobals());

describe("zendesk adapter — record mapping + cursor", () => {
  it("maps tickets, sideloads requester email, advances the cursor, marks done", async () => {
    const body = {
      tickets: [
        { id: 1, subject: "Export is broken", description: "CSV export 500s", requester_id: 7, updated_at: "2026-01-01T00:00:00Z", status: "open" },
        { id: 2, subject: "", description: "", requester_id: 8 }, // empty → skipped
      ],
      users: [{ id: 7, email: "maya@globex.com", name: "Maya" }],
      end_time: 1735700000,
      end_of_stream: true,
    };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const page = await zendesk.listSince(conn(), null);

    expect(page.records).toHaveLength(1); // empty ticket dropped
    expect(page.records[0]).toMatchObject({
      externalId: "1",
      authorEmail: "maya@globex.com",
      authorName: "Maya",
      url: "https://acme.zendesk.com/agent/tickets/1",
    });
    expect(page.records[0].text).toContain("Export is broken");
    expect(page.nextCursor).toBe("1735700000");
    expect(page.done).toBe(true);

    // first sync (cursor null) must request a start_time, with users sideloaded
    const calledUrl = String((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(calledUrl).toContain("/api/v2/incremental/tickets.json");
    expect(calledUrl).toContain("include=users");
    expect(calledUrl).toContain("start_time=");
  });

  it("returns an empty, done page when the connection is incomplete", async () => {
    const bad = { accessToken: null, config: {}, workspaceId: "ws-1" } as unknown as IntegrationConnection;
    const page = await zendesk.listSince(bad, null);
    expect(page.records).toEqual([]);
    expect(page.done).toBe(true);
  });

  it("degrades to a done page on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch);
    const page = await zendesk.listSince(conn(), "1735600000");
    expect(page.records).toEqual([]);
    expect(page.done).toBe(true);
    expect(page.nextCursor).toBe("1735600000"); // cursor unchanged on failure
  });
});
