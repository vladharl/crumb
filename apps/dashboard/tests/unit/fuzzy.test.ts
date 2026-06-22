import { describe, it, expect } from "vitest";
import { fuzzyMatch, splitTerms, matchesTerms } from "@/lib/fuzzy";

// A representative inbox haystack: the server builds this lowercased, with the
// item's fields, people, initiative, and every comment body joined by spaces.
const hay =
  "fb-246 mobile layout breaks on ipad landscape bug in review " +
  "acme co maya enterprise sso & saml " +
  "the dashboard grid overflows when rotating the ipad. " +
  "comment from maya: still reproduces on ios 17, padding looks wrong on the cohort panel";

describe("lib/fuzzy", () => {
  it("matches a plain substring anywhere in the blob (title)", () => {
    expect(fuzzyMatch("ipad landscape", hay)).toBe(true);
  });

  it("searches body and comment text, not just titles", () => {
    expect(fuzzyMatch("cohort panel", hay)).toBe(true); // from a comment
    expect(fuzzyMatch("overflows", hay)).toBe(true); // from the body
    expect(fuzzyMatch("ios 17", hay)).toBe(true); // from a comment
  });

  it("searches people, account and initiative", () => {
    expect(fuzzyMatch("maya", hay)).toBe(true);
    expect(fuzzyMatch("acme", hay)).toBe(true);
    expect(fuzzyMatch("saml", hay)).toBe(true);
  });

  it("requires every term to match (AND), order-independent", () => {
    expect(fuzzyMatch("landscape ipad", hay)).toBe(true);
    expect(fuzzyMatch("ipad keyboard", hay)).toBe(false); // 'keyboard' absent
  });

  it("tolerates typos on longer terms", () => {
    expect(fuzzyMatch("landscpe", hay)).toBe(true); // transposed/missing char
    expect(fuzzyMatch("dashboard", hay)).toBe(true); // swapped letters
    expect(fuzzyMatch("cohrot", hay)).toBe(true); // cohort
  });

  it("does not fuzz tiny terms into noise", () => {
    expect(fuzzyMatch("xyz", hay)).toBe(false);
    expect(fuzzyMatch("zzz", hay)).toBe(false);
  });

  it("rejects words too far from anything in the blob", () => {
    expect(fuzzyMatch("helicopter", hay)).toBe(false);
  });

  it("treats an empty query as match-all", () => {
    expect(fuzzyMatch("", hay)).toBe(true);
    expect(fuzzyMatch("   ", hay)).toBe(true);
    expect(splitTerms("  ")).toEqual([]);
  });

  it("matchesTerms works with pre-split terms", () => {
    expect(matchesTerms(["acme", "saml"], hay)).toBe(true);
    expect(matchesTerms(["acme", "nope"], hay)).toBe(false);
  });
});
