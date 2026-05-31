import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Capture the request bodies the lib sends to aistack. The lib talks to the
// OpenAI-compatible /chat/completions endpoint directly (plain fetch, no SDK),
// so we stub global.fetch and read the prompt out of the request body.
const fetchCalls: Array<{ url: string; body: { messages: Array<{ role: string; content: string }> } }> = [];

function aistackResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

const ticketReply = JSON.stringify({
  title: "AI test draft",
  body: "AI body",
  labels: ["bug"],
  reason: "looks like a bug report",
  confidence: 0.82,
});

beforeAll(() => {
  process.env.CRUMB_TIER = "cloud";
  process.env.AISTACK_API_KEY = "test-key";
});

beforeEach(() => {
  fetchCalls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return aistackResponse(ticketReply);
  }));
});

function lastPrompt(): string {
  return fetchCalls.at(-1)!.body.messages[0].content;
}

describe("lib/ai/ticket suggestTicket", () => {
  it("includes item title + body and caps body at 1200 chars", async () => {
    const { suggestTicket } = await import("@/lib/ai/ticket");
    const longBody = "a".repeat(5000);
    const r = await suggestTicket({
      provider: "linear",
      item: { title: "User can't log in", body: longBody, type: "bug" },
      recentTickets: [],
    });
    expect(r).not.toBeNull();
    const prompt = lastPrompt();
    expect(prompt).toContain("User can't log in");
    // Body was capped — should contain a 1200-char run of "a" but not 5000.
    expect(prompt).toContain("a".repeat(1200));
    expect(prompt).not.toContain("a".repeat(1201));
  });

  it("caps recent tickets at 10", async () => {
    const { suggestTicket } = await import("@/lib/ai/ticket");
    const many = Array.from({ length: 25 }, (_, i) => ({
      identifier: `ENG-${i}`,
      title: `Recent ticket ${i}`,
      stateName: "Backlog",
    }));
    await suggestTicket({
      provider: "linear",
      item: { title: "t", body: "b", type: "bug" },
      recentTickets: many,
    });
    const prompt = lastPrompt();
    // The first 10 identifiers should appear; the 11th must not.
    expect(prompt).toContain("ENG-0");
    expect(prompt).toContain("ENG-9");
    expect(prompt).not.toContain("ENG-10:");
  });

  it("includes README + tree when repoContext is provided", async () => {
    const { suggestTicket } = await import("@/lib/ai/ticket");
    const readme = "# My Project\nWe build widgets.";
    const tree = "src/, tests/, README.md, package.json";
    await suggestTicket({
      provider: "jira",
      item: { title: "feature request", body: "", type: "idea" },
      recentTickets: [],
      repoContext: { repo: "acme/widget", readme, topLevelTree: tree },
    });
    const prompt = lastPrompt();
    expect(prompt).toContain("README");
    expect(prompt).toContain("We build widgets.");
    expect(prompt).toContain("src/, tests/");
  });

  it("caps README at 4000 chars", async () => {
    const { suggestTicket } = await import("@/lib/ai/ticket");
    const longReadme = "x".repeat(10000);
    await suggestTicket({
      provider: "github",
      item: { title: "t", body: "b", type: "bug" },
      recentTickets: [],
      repoContext: { repo: "acme/widget", readme: longReadme, topLevelTree: null },
    });
    const prompt = lastPrompt();
    expect(prompt).toContain("x".repeat(4000));
    expect(prompt).not.toContain("x".repeat(4001));
  });

  it("disables server-side tools and targets the chat endpoint", async () => {
    const { suggestTicket } = await import("@/lib/ai/ticket");
    await suggestTicket({
      provider: "linear",
      item: { title: "t", body: "b", type: "bug" },
      recentTickets: [],
    });
    const call = fetchCalls.at(-1)!;
    expect(call.url).toContain("/chat/completions");
    expect((call.body as unknown as { tools_enabled: boolean }).tools_enabled).toBe(false);
  });
});
