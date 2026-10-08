import { beforeAll, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@/lib/validation";

// The widget's failure copy, reply shortcut and identity helpers (audits #28,
// #29, #73). Customers used to see raw codes (jwt_expired, Failed to fetch),
// Enter sent half-composed Chinese/Japanese text, and a sign-in couldn't
// change after the script loaded.

// widget.ts installs window.crumb and looks for its <script> tag at load; node
// has neither, so it finds no tag and stops after the stub.
let w: typeof import("../../../widget/src/widget");
beforeAll(async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { currentScript: null, scripts: [] });
  w = await import("../../../widget/src/widget");
});

describe("widget error copy", () => {
  it("never puts a raw code on screen", () => {
    const codes = ["jwt_expired", "jwt_signature", "jwt_required", "invalid_token", "network", "rate_limited",
      "file_too_large", "unsupported_type", "not_your_item", "item_not_found", "title_too_long",
      "workspace_not_found", "already_closed", "", "Failed to fetch"];
    for (const code of codes) {
      for (const status of [0, 400, 401, 403, 404, 413, 415, 429, 500, 502]) {
        expect(w.friendlyError(code, status)).not.toMatch(/_|HTTP|\d{3}|fetch|—/);
      }
    }
  });

  it("names what happened and what to do", () => {
    expect(w.friendlyError("jwt_expired", 401)).toMatch(/session expired/i);
    expect(w.friendlyError("jwt_signature", 401)).toMatch(/signed in/i);
    expect(w.friendlyError("network")).toMatch(/connect/i);
    expect(w.friendlyError("rate_limited", 429)).toMatch(/too many attempts/i);
    expect(w.friendlyError("", 413)).toMatch(/too large/i);
    expect(w.friendlyError("unsupported_type", 415)).toMatch(/isn.t supported/i);
    expect(w.friendlyError("not_your_item", 403)).toBe("This request belongs to someone else.");
    expect(w.friendlyError("already_closed", 409)).toBe("This request is already closed.");
    expect(w.friendlyError("", 502)).toMatch(/on our end/i);
  });
});

describe("reply box", () => {
  const key = (o: Partial<KeyboardEvent>) =>
    ({ key: "Enter", metaKey: false, ctrlKey: false, isComposing: false, keyCode: 13, ...o }) as KeyboardEvent;

  it("sends on Cmd/Ctrl+Enter, keeps plain Enter as a newline, never sends mid-IME", () => {
    expect(w.isSendShortcut(key({}))).toBe(false);
    expect(w.isSendShortcut(key({ metaKey: true }))).toBe(true);
    expect(w.isSendShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(w.isSendShortcut(key({ ctrlKey: true, isComposing: true }))).toBe(false);
    // Safari's candidate-confirming Enter: isComposing already false, keyCode 229.
    expect(w.isSendShortcut(key({ metaKey: true, keyCode: 229 }))).toBe(false);
  });

  it("caps fields at the API's limits", () => {
    expect(w.MAX_LEN).toEqual({ title: LIMITS.title, body: LIMITS.body, reply: LIMITS.reply });
  });
});

describe("identity", () => {
  const token = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

  it("reads the customer from a token to key drafts and spot a user switch", () => {
    expect(w.jwtSub(token({ iss: "acme", sub: "maya@acme.co" }))).toBe("maya@acme.co");
    expect(w.jwtSub(token({ iss: "acme" }))).toBe("");
    expect(w.jwtSub("not-a-token")).toBe("");
  });

  it("queues identify, shutdown and onTokenExpired until the widget mounts", () => {
    const api = window.crumb!;
    const cb = () => {};
    api.onTokenExpired(cb);
    api.identify({ jwt: "t" });
    api.shutdown();
    expect(api.q).toEqual([["onTokenExpired", [cb]], ["identify", [{ jwt: "t" }]], ["shutdown", []]]);
  });
});
