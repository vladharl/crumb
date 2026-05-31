import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Mirrors ai-ticket.test.ts: stub global.fetch (the lib calls the aistack
// OpenAI-compatible endpoint directly) and drive the parse/validation paths
// of suggestInitiative by varying the assistant content the mock returns.
const fetchCalls: Array<{ url: string; body: { messages: Array<{ role: string; content: string }> } }> = [];
let nextReply = "";

function aistackResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

const INITIATIVES = [
  { id: "init-aaaa", name: "Exports", description: "CSV + funnel exports" },
  { id: "init-bbbb", name: "Mobile polish", description: "tablet + locale fixes" },
];

beforeAll(() => {
  process.env.CRUMB_TIER = "cloud";
  process.env.AISTACK_API_KEY = "test-key";
});

beforeEach(() => {
  fetchCalls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return aistackResponse(nextReply);
  }));
});

function lastPrompt(): string {
  return fetchCalls.at(-1)!.body.messages[0].content;
}

describe("lib/ai/cluster suggestInitiative", () => {
  it("builds the prompt with initiatives + item and caps body at 1200 chars", async () => {
    const { suggestInitiative } = await import("@/lib/ai/cluster");
    nextReply = JSON.stringify({ initiative_id: "init-aaaa", confidence: 0.9, reason: "asks for CSV export" });
    const longBody = "z".repeat(5000);
    const r = await suggestInitiative(
      { title: "Need a CSV download", body: longBody, type: "idea" },
      INITIATIVES,
    );
    expect(r).toEqual({ initiativeId: "init-aaaa", confidence: 0.9, reason: "asks for CSV export" });
    const prompt = lastPrompt();
    expect(prompt).toContain("init-aaaa");
    expect(prompt).toContain("Need a CSV download");
    // Body capped at 1200.
    expect(prompt).toContain("z".repeat(1200));
    expect(prompt).not.toContain("z".repeat(1201));
  });

  it("returns null when confidence is below the 0.55 threshold", async () => {
    const { suggestInitiative } = await import("@/lib/ai/cluster");
    nextReply = JSON.stringify({ initiative_id: "init-aaaa", confidence: 0.4, reason: "weak match" });
    const r = await suggestInitiative({ title: "t", body: "b", type: "idea" }, INITIATIVES);
    expect(r).toBeNull();
  });

  it("returns null when the model picks an id that isn't a candidate", async () => {
    const { suggestInitiative } = await import("@/lib/ai/cluster");
    nextReply = JSON.stringify({ initiative_id: "init-zzzz", confidence: 0.95, reason: "hallucinated id" });
    const r = await suggestInitiative({ title: "t", body: "b", type: "idea" }, INITIATIVES);
    expect(r).toBeNull();
  });

  it("returns null when initiative_id is null (model declined)", async () => {
    const { suggestInitiative } = await import("@/lib/ai/cluster");
    nextReply = JSON.stringify({ initiative_id: null, confidence: 0.2, reason: "nothing fits" });
    const r = await suggestInitiative({ title: "t", body: "b", type: "idea" }, INITIATIVES);
    expect(r).toBeNull();
  });

  it("tolerates reasoning preamble / code fences around the JSON", async () => {
    const { suggestInitiative } = await import("@/lib/ai/cluster");
    nextReply = "Let me think about this...\n```json\n" +
      JSON.stringify({ initiative_id: "init-bbbb", confidence: 0.7, reason: "iPad layout bug" }) +
      "\n```";
    const r = await suggestInitiative({ title: "iPad broken", body: "", type: "bug" }, INITIATIVES);
    expect(r).toEqual({ initiativeId: "init-bbbb", confidence: 0.7, reason: "iPad layout bug" });
  });

  it("skips the API call entirely when there are no initiatives", async () => {
    const { suggestInitiative } = await import("@/lib/ai/cluster");
    const r = await suggestInitiative({ title: "t", body: "b", type: "idea" }, []);
    expect(r).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });
});
