import { describe, it, expect } from "vitest";
import { IntegrationAuthError, isSlackRevokedError } from "@/lib/integrations/revoke";

describe("lib/integrations/revoke", () => {
  it("IntegrationAuthError carries the provider + a stable message", () => {
    const e = new IntegrationAuthError("jira", "401");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(IntegrationAuthError);
    expect(e.provider).toBe("jira");
    expect(e.message).toBe("integration_auth_failed:jira:401");
  });

  it("is catchable via instanceof across a throw", () => {
    let caught: unknown;
    try { throw new IntegrationAuthError("linear"); } catch (e) { caught = e; }
    expect(caught instanceof IntegrationAuthError).toBe(true);
    if (caught instanceof IntegrationAuthError) expect(caught.provider).toBe("linear");
  });

  it("recognizes Slack revoked-token error codes", () => {
    for (const code of ["token_revoked", "account_inactive", "invalid_auth", "not_authed"]) {
      expect(isSlackRevokedError(code)).toBe(true);
    }
  });

  it("does not treat transient/other Slack errors as revocation", () => {
    expect(isSlackRevokedError("channel_not_found")).toBe(false);
    expect(isSlackRevokedError("ratelimited")).toBe(false);
    expect(isSlackRevokedError(undefined)).toBe(false);
    expect(isSlackRevokedError("")).toBe(false);
  });
});
