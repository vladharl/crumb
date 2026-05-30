import { describe, it, expect } from "vitest";
import { createItemSchema, createReplySchema, LIMITS } from "@/lib/validation";

describe("lib/validation — createItemSchema", () => {
  it("accepts a minimal valid item and trims title", () => {
    const r = createItemSchema.safeParse({ type: "bug", title: "  Crash on save  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.title).toBe("Crash on save");
  });

  it("rejects an unknown type with the stable 'invalid_type' code", () => {
    const r = createItemSchema.safeParse({ type: "feature", title: "x" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("invalid_type");
  });

  it("rejects a missing/blank title with 'missing_title'", () => {
    const r = createItemSchema.safeParse({ type: "idea", title: "   " });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("missing_title");
  });

  it("rejects an over-long title", () => {
    const r = createItemSchema.safeParse({ type: "idea", title: "a".repeat(LIMITS.title + 1) });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("title_too_long");
  });

  it("rejects an over-long body", () => {
    const r = createItemSchema.safeParse({ type: "bug", title: "ok", body: "x".repeat(LIMITS.body + 1) });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("body_too_long");
  });

  it("rejects a malformed session_token", () => {
    const r = createItemSchema.safeParse({ type: "bug", title: "ok", session_token: "nope" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("invalid_session_token");
  });

  it("strips unknown keys", () => {
    const r = createItemSchema.safeParse({ type: "bug", title: "ok", evil: "<script>", extra: 1 });
    expect(r.success).toBe(true);
    if (r.success) expect("evil" in r.data).toBe(false);
  });

  it("rejects an email without an @", () => {
    const r = createItemSchema.safeParse({ type: "bug", title: "ok", account_user_email: "notanemail" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("invalid_email");
  });
});

describe("lib/validation — createReplySchema", () => {
  it("accepts a reply with body + attachment_ids", () => {
    const r = createReplySchema.safeParse({ body: "thanks", attachment_ids: ["a", "b"] });
    expect(r.success).toBe(true);
  });

  it("caps attachment_ids count at 50", () => {
    const r = createReplySchema.safeParse({ attachment_ids: Array.from({ length: 51 }, (_, i) => `id${i}`) });
    expect(r.success).toBe(false);
  });

  it("rejects an over-long reply body", () => {
    const r = createReplySchema.safeParse({ body: "x".repeat(LIMITS.reply + 1) });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("body_too_long");
  });
});
