import { describe, it, expect } from "vitest";
import { errorMessage } from "@/lib/action-error";

const FALLBACK = "Something went wrong. Please try again.";

describe("lib/action-error", () => {
  it("maps known server-action codes to plain sentences", () => {
    expect(errorMessage("forbidden")).toBe("You don't have permission to do that.");
    expect(errorMessage("reason_required")).toBe("Add a short reason first.");
    expect(errorMessage("no_items")).toBe("Nothing was selected.");
    expect(errorMessage("not_a_member")).toBe(errorMessage("bad_assignee"));
    // The AI cap names a next step, not just the wait.
    expect(errorMessage("ai_cap_reached")).toMatch(/resets on the 1st\. An admin can .* under Settings → Billing\.$/);
  });

  it("covers the common codes without leaking the code, an em-dash or an en-dash", () => {
    const codes = [
      "forbidden", "admin_only", "not_found", "no_item", "no_items", "bad_status", "bad_assignee",
      "not_a_member", "reason_required", "empty", "already_decided", "already_closed", "rate_limited",
      "ai_cap_reached", "not_entitled", "plan_required", "not_configured", "same_item",
      "target_is_duplicate", "not_merged",
    ];
    for (const code of codes) {
      const msg = errorMessage(code);
      expect(msg, code).not.toBe(FALLBACK);
      expect(msg, code).toMatch(/^[A-Z].*\.$/);
      expect(msg, code).not.toMatch(/[_–—]/);
    }
  });

  it("falls back to a generic sentence for unknown or missing codes", () => {
    for (const code of ["something_new", "", null, undefined]) {
      expect(errorMessage(code)).toBe(FALLBACK);
    }
  });

  it("passes through errors that are already sentences", () => {
    expect(errorMessage("Enter a valid email for the submitter.")).toBe("Enter a valid email for the submitter.");
  });
});
