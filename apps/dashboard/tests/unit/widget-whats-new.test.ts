import { beforeAll, describe, expect, it, vi } from "vitest";

// What's new in the widget (audit #36): the tab, and each entry, carry a dot
// for changelog entries published since the customer last looked.

let w: typeof import("../../../widget/src/widget");
beforeAll(async () => {
  // widget.ts looks for its <script> tag at load; node has none, so it stops after the stub.
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { currentScript: null, scripts: [] });
  w = await import("../../../widget/src/widget");
});

const entry = (published_at: string | null) => ({ id: "e1", title: "Exports include every row", body: "", published_at });

describe("What's new", () => {
  it("is unseen when published after the newest entry the customer saw", () => {
    const seen = "2026-10-01T12:00:00.000Z";
    expect(w.newsUnseen(entry("2026-10-02T09:00:00.000Z"), seen)).toBe(true);
    expect(w.newsUnseen(entry(seen), seen)).toBe(false);
    expect(w.newsUnseen(entry("2026-09-30T09:00:00.000Z"), seen)).toBe(false);
  });

  it("is all unseen on a device that never looked", () => {
    expect(w.newsUnseen(entry("2025-01-01T00:00:00.000Z"), null)).toBe(true);
  });
});
