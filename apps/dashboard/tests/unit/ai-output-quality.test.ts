import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { noEmDash, NO_EM_DASH_RULE } from "@/lib/ai/aistack";
import { askIntent } from "@/lib/ai/ask";
import { scrubStyleExample, draftReply } from "@/lib/ai/reply";
import { suggestTicket, ticketImpactFooter } from "@/lib/ai/ticket";

// Audit #88: what the AI features hand the model and what reaches the screen.
// The aistack endpoint is stubbed via global fetch, like ai-ticket.test.ts.

let nextReply = "";
const prompts: string[] = [];

beforeAll(() => {
  process.env.CRUMB_TIER = "cloud";
  process.env.AISTACK_API_KEY = "test-key";
});

beforeEach(() => {
  prompts.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    prompts.push(JSON.parse(init.body).messages[0].content);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: nextReply } }] }) } as unknown as Response;
  }));
});

describe("noEmDash", () => {
  it("turns dash punctuation into commas and keeps ranges", () => {
    expect(noEmDash("Thanks — we're on it.")).toBe("Thanks, we're on it.");
    expect(noEmDash("Yes—exactly")).toBe("Yes, exactly");
    expect(noEmDash("Fast – and cheap")).toBe("Fast, and cheap");
    expect(noEmDash("Shipped last week —.")).toBe("Shipped last week.");
    expect(noEmDash("— The team\nLine one —\nnext")).toBe("The team\nLine one\nnext");
    expect(noEmDash("2–5 sentences, 9:00 – 17:00")).toBe("2–5 sentences, 9:00 – 17:00");
  });

  it("catches an em-dash escaped inside JSON", () => {
    const escaped = "\\" + "u2014"; // the six characters a model may emit instead of the dash
    const raw = `{"draft":"Thanks ${escaped} soon"}`;
    expect(raw).not.toContain("—");
    expect(JSON.parse(noEmDash(raw)).draft).toBe("Thanks, soon");
  });
});

describe("askIntent", () => {
  it("reads revenue and time cues", () => {
    expect(askIntent("What do our highest-ARR accounts keep asking for?")).toEqual({ byArr: true, windowDays: null });
    expect(askIntent("What did customers ask for last month?")).toEqual({ byArr: false, windowDays: 30 });
    expect(askIntent("Which enterprise accounts want SSO, past 2 weeks?")).toEqual({ byArr: true, windowDays: 14 });
    expect(askIntent("What came in today from our top customers?")).toEqual({ byArr: true, windowDays: 1 });
    expect(askIntent("Which bugs are blocking the most customers?")).toEqual({ byArr: false, windowDays: null });
    expect(askIntent("Does the export array sort?")).toEqual({ byArr: false, windowDays: null });
  });
});

describe("reply drafts", () => {
  it("scrubs another customer's details out of a style example", () => {
    expect(scrubStyleExample(
      "Hi Sarah, we shipped CSV export for Acme on March 4 (v2.3). See https://acme.com/changelog or write sarah@acme.com.",
      ["Acme Co", "Sarah Connor"],
    )).toBe("Hi [name], we shipped CSV export for [name] on March [number] (v[number]). See [link] or write [email].");
    expect(scrubStyleExample("Gracias José, ya está. Banana!", ["José Núñez", "Ana"])).toBe("Gracias [name], ya está. Banana!");
    expect(scrubStyleExample("The fix is live for The Data Company and the data team.", ["The Data Company"]))
      .toBe("The fix is live for The [name] [name] and the data team.");
  });

  it("drafts from this thread, in the customer's language, without em-dashes", async () => {
    nextReply = JSON.stringify({ draft: "Gracias — ya está en camino.", reason: "planned", confidence: 0.8 });
    const r = await draftReply({
      item: { title: "Exportar a CSV", body: "Necesitamos exportar.", type: "idea", status: "planned" },
      lang: "es",
      thread: [
        { fromVendor: false, body: "¿Hay novedades?" },
        { fromVendor: true, body: "Lo tenemos planeado." },
      ],
      styleExamples: [{ body: "Hi Sarah, Acme gets it on May 2.", names: ["Acme Co", "Sarah Connor"] }],
    });
    expect(r?.draft).toBe("Gracias, ya está en camino.");
    const p = prompts[0];
    expect(p).toContain("Customer: ¿Hay novedades?\n\nVendor: Lo tenemos planeado.");
    expect(p).toContain("Write the reply in Spanish.");
    expect(p).toContain("Hi [name], [name] gets it on May [number].");
    expect(p).not.toContain("Sarah");
    expect(p).toContain(NO_EM_DASH_RULE);
  });
});

describe("ticket drafts", () => {
  const impact = {
    accountName: "Acme Co",
    arrCents: 25_000_000,
    accounts: 3,
    combinedArrCents: 41_000_000,
    requesters: 4,
    threadUrl: "https://app.test/thread/FB-12",
  };

  it("states who is asking, their ARR and the way back", () => {
    expect(ticketImpactFooter(impact)).toBe(
      "Customer impact: Acme Co, $250k ARR. 4 requesters across 3 accounts, $410k ARR combined.\n\nThread in Crumb: https://app.test/thread/FB-12",
    );
    expect(ticketImpactFooter({ ...impact, arrCents: 0, accounts: 1, requesters: 1, threadUrl: null }))
      .toBe("Customer impact: Acme Co, ARR not set. 1 requester.");
    // A GitHub repo may be public: no customer name or revenue.
    expect(ticketImpactFooter(impact, "github")).toBe(
      "Customer impact: 4 requesters across 3 accounts.\n\nThread in Crumb: https://app.test/thread/FB-12",
    );
  });

  it("appends the impact footer and keeps the model's labels", async () => {
    nextReply = JSON.stringify({
      title: "Add CSV export",
      body: "Users can't export — it blocks renewals.",
      labels: ["export", "export", "csv, reports", 7],
      reason: "clear ask",
      confidence: 0.8,
    });
    const r = await suggestTicket({
      provider: "linear",
      item: { title: "CSV export", body: "We need CSV", type: "idea" },
      recentTickets: [],
      impact,
    });
    expect(r?.body).toBe(`Users can't export, it blocks renewals.\n\n${ticketImpactFooter(impact)}`);
    expect(r?.labels).toEqual(["export", "csv reports"]);
    // The model never sees the figures it might restate.
    expect(prompts[0]).not.toContain("$250k");
  });
});
