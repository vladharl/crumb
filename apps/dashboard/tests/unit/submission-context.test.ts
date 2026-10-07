import { describe, it, expect } from "vitest";
import { createItemSchema, createUsageEventsSchema, redactContextUrl, CONTEXT_LIMITS } from "@/lib/validation";

// Submission context (#71): best-effort page / browser / build metadata the
// widget attaches to POST /api/v1/items. It must never cost the customer their
// feedback, must stay bounded, and must not carry secrets from the host page's
// URL into the vendor's dashboard.

const parse = (context: unknown) => {
  const r = createItemSchema.safeParse({ type: "bug", title: "Export breaks", context });
  expect(r.success).toBe(true);
  return r.success ? r.data.context : undefined;
};

describe("submission context", () => {
  it("keeps a well-formed context", () => {
    expect(parse({
      page_url: "https://app.acme.com/settings/billing?tab=plans",
      page_title: "Billing",
      referrer: "https://app.acme.com/home",
      user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/129.0.0.0 Safari/537.36",
      viewport: { w: 1440, h: 900 },
      locale: "en-US",
      app_version: "4.2.1",
      extra: "stripped",
    })).toEqual({
      page_url: "https://app.acme.com/settings/billing?tab=plans",
      page_title: "Billing",
      referrer: "https://app.acme.com/home",
      user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/129.0.0.0 Safari/537.36",
      viewport: { w: 1440, h: 900 },
      locale: "en-US",
      app_version: "4.2.1",
    });
  });

  it("redacts secret-looking query and fragment values and drops user:pass@", () => {
    expect(redactContextUrl(
      "https://bob:hunter2@app.acme.com/cb?code=abc&state=xyz&api_key=k1&accessToken=t1&q=shoes#id_token=jwt1&view=grid",
    )).toBe(
      "https://app.acme.com/cb?code=[redacted]&state=xyz&api_key=[redacted]&accessToken=[redacted]&q=shoes#id_token=[redacted]&view=grid",
    );
    expect(redactContextUrl("https://a.test/?session=s&password=p&Auth=a&secret=x&ok=1"))
      .toBe("https://a.test/?session=[redacted]&password=[redacted]&Auth=[redacted]&secret=[redacted]&ok=1");
  });

  it("keeps only http(s) URLs, since they render as links", () => {
    expect(redactContextUrl("javascript:alert(1)")).toBeUndefined();
    expect(redactContextUrl("data:text/html,hi")).toBeUndefined();
    expect(redactContextUrl("  HTTP://a.test/x  ")).toBe("HTTP://a.test/x");
    expect(parse({ page_url: "javascript:alert(1)", referrer: "https://a.test/" })).toEqual({ referrer: "https://a.test/" });
  });

  it("truncates long text instead of rejecting the submission", () => {
    const c = parse({
      page_url: `https://a.test/${"p".repeat(5_000)}?token=secret`,
      page_title: `  ${"t".repeat(1_000)}  `,
      user_agent: "u".repeat(2_000),
      app_version: "v".repeat(500),
    });
    expect(c?.page_url).toHaveLength(CONTEXT_LIMITS.url);
    expect(c?.page_url).not.toContain("secret");
    expect(c?.page_title).toBe("t".repeat(CONTEXT_LIMITS.title));
    expect(c?.user_agent).toHaveLength(CONTEXT_LIMITS.userAgent);
    expect(c?.app_version).toHaveLength(CONTEXT_LIMITS.appVersion);
  });

  it("drops malformed fields one by one, and ignores a context that isn't an object", () => {
    expect(parse({ page_title: 42, viewport: { w: "wide", h: 900 }, locale: "fr-FR" })).toEqual({ locale: "fr-FR" });
    expect(parse({ viewport: { w: 1440.4, h: 899.6 } })).toEqual({ viewport: { w: 1440, h: 900 } });
    expect(parse({ viewport: { w: -1, h: 900 } })).toBeUndefined();
    expect(parse({ page_title: "   " })).toBeUndefined();
    expect(parse("https://a.test/")).toBeUndefined();
    expect(parse(null)).toBeUndefined();
    expect(parse(undefined)).toBeUndefined();
  });
});

describe("usage events (crumb.track)", () => {
  it("redact their page URL the same way", () => {
    const r = createUsageEventsSchema.safeParse({
      events: [{ name: "signed_in", page_url: "https://app.acme.com/cb?code=abc&state=ok" }, { name: "export" }],
    });
    expect(r.success && r.data.events.map(e => e.page_url)).toEqual(["https://app.acme.com/cb?code=[redacted]&state=ok", undefined]);
  });
});
