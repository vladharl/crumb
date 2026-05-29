import { describe, it, expect, beforeAll, vi } from "vitest";

// Capture the prompt strings the lib sends to Anthropic. We mock the SDK
// before importing the module under test.
const createCalls: Array<{ model: string; messages: Array<{ role: string; content: string }>; max_tokens: number }> = [];

vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = {
      create: vi.fn(async (req: { model: string; messages: Array<{ role: string; content: string }>; max_tokens: number }) => {
        createCalls.push(req);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              title: "AI test draft",
              body: "AI body",
              labels: ["bug"],
              reason: "looks like a bug report",
              confidence: 0.82,
            }),
          }],
        };
      }),
    };
    constructor(_opts: { apiKey: string }) { /* swallow */ }
  }
  return { default: Anthropic };
});

beforeAll(() => {
  process.env.CRUMB_TIER = "cloud";
  process.env.ANTHROPIC_API_KEY = "test-key";
});

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
    const prompt = createCalls.at(-1)!.messages[0].content;
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
    const prompt = createCalls.at(-1)!.messages[0].content;
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
    const prompt = createCalls.at(-1)!.messages[0].content;
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
    const prompt = createCalls.at(-1)!.messages[0].content;
    expect(prompt).toContain("x".repeat(4000));
    expect(prompt).not.toContain("x".repeat(4001));
  });
});
