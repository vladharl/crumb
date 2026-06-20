import { describe, it, expect } from "vitest";
import { EVENT_TYPES, EVENT_LABELS, isEventType } from "@/lib/event-catalog";

describe("lib/event-catalog", () => {
  it("isEventType accepts catalog types and rejects others", () => {
    expect(isEventType("item.status_changed")).toBe(true);
    expect(isEventType("item.created")).toBe(true);
    expect(isEventType("item.reply_created")).toBe(true);
    expect(isEventType("item.bogus")).toBe(false);
    expect(isEventType("")).toBe(false);
  });

  it("every event type has a non-empty label", () => {
    for (const t of EVENT_TYPES) expect(EVENT_LABELS[t]).toBeTruthy();
  });

  it("has no duplicate types", () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });
});
