import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { callbackUrlFromHeaders, callbackUrlFromRequest } from "@/lib/integrations/callback-url";

// The authorize step and the token exchange must send the provider the same
// redirect_uri, or it refuses the exchange. Behind a proxy with no
// CRUMB_APP_URL, the callback's req.url is the internal address, so the
// exchange takes the forwarded host, as the authorize step does.

const h = vi.hoisted(() => ({
  forwarded: new Headers({ "x-forwarded-host": "crumb.example.test", "x-forwarded-proto": "https" }),
}));
vi.mock("next/headers", () => ({ headers: () => h.forwarded }));

describe("OAuth redirect_uri", () => {
  beforeAll(() => vi.stubEnv("CRUMB_APP_URL", ""));
  afterAll(() => vi.unstubAllEnvs());

  it("is the public URL at both steps behind a proxy, not the internal one", () => {
    const req = new Request("http://0.0.0.0:3000/api/integrations/slack/callback?code=c", { headers: h.forwarded });
    expect(callbackUrlFromRequest("slack", null, req)).toBe("https://crumb.example.test/api/integrations/slack/callback");
    expect(callbackUrlFromHeaders("slack", null)).toBe(callbackUrlFromRequest("slack", null, req));
  });
});
