import { describe, expect, it } from "vitest";

import { secretMatches } from "@/lib/secret-match";

describe("secretMatches", () => {
  it("accepts only the exact secret", () => {
    expect(secretMatches("s3cret", "s3cret")).toBe(true);
    expect(secretMatches("s3creT", "s3cret")).toBe(false);
    expect(secretMatches("s3cret-longer", "s3cret")).toBe(false);
    expect(secretMatches("", "s3cret")).toBe(false);
    expect(secretMatches(null, "s3cret")).toBe(false);
    expect(secretMatches(undefined, "s3cret")).toBe(false);
  });
});
