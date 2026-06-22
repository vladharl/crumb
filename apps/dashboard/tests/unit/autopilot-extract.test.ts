import { describe, it, expect } from "vitest";
import { parseExtraction } from "@/lib/ai/extract-feedback";

describe("parseExtraction — extraction gate output", () => {
  it("parses a clean JSON array of feedback units", () => {
    const out = parseExtraction(
      '[{"title":"Bulk export","body":"Wants CSV export of all items.","type":"idea","severity":"medium","tags":["exports"],"relevance":0.9,"confidence":0.8}]',
    );
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({ title: "Bulk export", type: "idea", severity: "medium" });
    expect(out![0].tags).toEqual(["exports"]);
  });

  it("returns [] when the model reports no feedback", () => {
    expect(parseExtraction("[]")).toEqual([]);
  });

  it("returns null on unparseable output (so the caller can fall back)", () => {
    expect(parseExtraction("sorry, I cannot help with that")).toBeNull();
    expect(parseExtraction(null)).toBeNull();
  });

  it("tolerates reasoning preamble and ```json fences (qwen leaks both)", () => {
    const out = parseExtraction(
      'Here is the result:\n```json\n[{"title":"Dark mode","type":"idea","relevance":0.7,"confidence":0.7}]\n```',
    );
    expect(out).toHaveLength(1);
    expect(out![0].title).toBe("Dark mode");
  });

  it("clamps relevance/confidence to 0..1 and drops untitled units", () => {
    const out = parseExtraction(
      '[{"title":"","body":"no title","relevance":5,"confidence":-2},{"title":"Real","relevance":2,"confidence":0.5}]',
    );
    expect(out).toHaveLength(1); // the untitled one is dropped
    expect(out![0].relevance).toBe(1); // 2 clamped to 1
    expect(out![0].confidence).toBe(0.5);
  });

  it("defaults an unknown type to idea and caps tags at 3, lowercased", () => {
    const out = parseExtraction(
      '[{"title":"X","type":"feature","tags":["A","B","C","D"],"relevance":0.5,"confidence":0.5}]',
    );
    expect(out![0].type).toBe("idea");
    expect(out![0].tags).toEqual(["a", "b", "c"]);
  });
});
