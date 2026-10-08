import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { retentionDaysForPlan } from "@/lib/replay/sweep";

// Session replay privacy. The recorder used to keep request + response bodies
// for every fetch/XHR and only redacted JSON-shaped secrets, so a form post
// (password=hunter2) landed in the replay verbatim. Bodies are now off unless
// the host opts in, and even then form, query and JSON secrets are redacted.
// The page URL (each chunk's page_url and rrweb's Meta event) is redacted the
// same way. Replays also used to live forever unless an operator configured
// retention.

// rrweb's recorder needs a DOM; the fake hands its emit callback to the test.
const rr = vi.hoisted(() => ({ emit: (_e: unknown) => {} }));
vi.mock("rrweb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("rrweb")>()),
  record: (opts: { emit: (e: unknown) => void }) => { rr.emit = opts.emit; return () => {}; },
}));

// widget-record.ts registers itself on `window` at load; node has none.
let rec: typeof import("../../../widget/src/widget-record");
beforeAll(async () => {
  vi.stubGlobal("window", { addEventListener: () => {} });
  rec = await import("../../../widget/src/widget-record");
});

const request = {
  method: "POST",
  url: "https://app.test/session?next=%2Fhome&access_token=tok-123",
  status: 200,
  durationMs: 42,
  reqBody: "user=pat&password=hunter2",
  respText: JSON.stringify({ sessionId: "sess-456", user: "pat" }),
};

describe("replay network capture", () => {
  it("records only method, redacted URL, status and timing by default", () => {
    const ev = rec.toNetEvent(request, false);
    expect(ev).toEqual({
      method: "POST",
      url: "https://app.test/session?next=%2Fhome&access_token=[redacted]",
      status: 200,
      durationMs: 42,
    });
    expect(JSON.stringify(ev)).not.toMatch(/tok-123|hunter2|sess-456/);
  });

  it("with the host opt-in keeps bodies but redacts form, query and JSON secrets", () => {
    const form = rec.toNetEvent({ ...request, reqBody: new URLSearchParams({ user: "pat", password: "hunter2" }) }, true);
    expect(form.reqBody).toBe("user=pat&password=[redacted]");
    expect(form.respBody).toBe('{"sessionId":"[redacted]","user":"pat"}');

    const json = rec.toNetEvent({
      ...request,
      reqBody: JSON.stringify({ login: { email: "pat@acme.test", password: 'hun"ter2' }, apiKey: 12345 }),
      respText: JSON.stringify({ file: "https://cdn.test/f.png?X-Amz-Signature=sig-789&w=200" }),
    }, true);
    expect(json.reqBody).toBe('{"login":{"email":"pat@acme.test","password":"[redacted]"},"apiKey":"[redacted]"}');
    expect(json.respBody).toBe('{"file":"https://cdn.test/f.png?X-Amz-Signature=[redacted]&w=200"}');
    expect(JSON.stringify([form, json])).not.toMatch(/tok-123|ter2|sess-456|12345|sig-789/);
  });

  it("redacts URL credentials, fragments and matrix params", () => {
    expect(rec.toNetEvent({ ...request, url: "https://pat:pw@api.test/x;jsessionid=abc?q=shoes#id_token=xyz" }, false).url)
      .toBe("https://api.test/x;jsessionid=[redacted]?q=shoes#id_token=[redacted]");
  });
});

describe("replay page URL", () => {
  it("is redacted in the chunk's page_url and in rrweb's Meta event", async () => {
    const href = "https://app.test/reset?token=tok-1&step=2#access_token=at-2";
    const hidden: Array<() => void> = [];
    const sent = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 202 }));
    vi.stubGlobal("location", { href });
    vi.stubGlobal("screen", { width: 1440, height: 900 });
    vi.stubGlobal("document", { visibilityState: "hidden", addEventListener: (_t: string, fn: () => void) => hidden.push(fn) });
    vi.stubGlobal("fetch", sent);

    window.__crumbRecord__!.start({ apiBase: "https://crumb.test", workspaceSlug: "acme", sessionToken: "s-1" });
    rr.emit({ type: 4, data: { href, width: 1440, height: 900 }, timestamp: 1 }); // rrweb Meta
    hidden.forEach(fn => fn()); // tab hidden → flush

    expect(sent).toHaveBeenCalledTimes(1);
    const chunk = JSON.parse(String(sent.mock.calls[0][1].body));
    const redacted = "https://app.test/reset?token=[redacted]&step=2#access_token=[redacted]";
    expect(chunk.page_url).toBe(redacted);
    expect(chunk.events[0].data.href).toBe(redacted);
    expect(JSON.stringify(chunk)).not.toMatch(/tok-1|at-2/);
  });
});

describe("replay retention", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("defaults to 30 days when unset; overrides still win; 0 keeps forever", () => {
    vi.stubEnv("CRUMB_REPLAY_RETENTION_DAYS", "");
    vi.stubEnv("CRUMB_REPLAY_RETENTION_DAYS_GROWTH", "");
    vi.stubEnv("CRUMB_REPLAY_RETENTION_DAYS_TEAM", "");
    expect(retentionDaysForPlan("growth")).toBe(30);

    vi.stubEnv("CRUMB_REPLAY_RETENTION_DAYS", "90");
    vi.stubEnv("CRUMB_REPLAY_RETENTION_DAYS_GROWTH", "7");
    expect(retentionDaysForPlan("growth")).toBe(7);
    expect(retentionDaysForPlan("team")).toBe(90);

    vi.stubEnv("CRUMB_REPLAY_RETENTION_DAYS", "0");
    expect(retentionDaysForPlan("team")).toBe(0);
  });

  // Compose hands .env to the container through env_file. An environment entry
  // for these would override the operator's "0 = keep forever" with the
  // 30-day default and delete replays anyway.
  it("reaches the docker-compose container", () => {
    const compose = readFileSync(resolve(__dirname, "../../../../docker-compose.yml"), "utf8");
    expect(compose).toMatch(/env_file:\n\s+- path: \.env\n\s+required: false/);
    expect(compose).not.toContain("CRUMB_REPLAY_RETENTION_DAYS:");
  });
});
