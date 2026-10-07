import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { redactContextUrl } from "@/lib/validation";
import { redactUrl } from "../../../widget/src/redact";

// The customer's side of the loop in the widget (audits #49, #50, #71, #77):
// unread counts only the vendor's replies, the status reason shows in plain
// words, secrets leave the submitted page URL before it does, and the vendor's
// accent fills buttons only where white text on it stays readable.

let w: typeof import("../../../widget/src/widget");
beforeAll(async () => {
  // widget.ts looks for its <script> tag at load; node has none, so it stops after the stub.
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { currentScript: null, scripts: [] });
  w = await import("../../../widget/src/widget");
});

type Item = Parameters<typeof import("../../../widget/src/widget").itemNews>[0];
const item = (o: Partial<Item> = {}): Item => ({
  short_id: "FB-1", title: "Dark mode", type: "idea", status: "open", created_at: "", updated_at: "",
  reply_count: 1, vendor_reply_count: 0, last_vendor_reply_at: null, last_event: null, ...o,
});

describe("unread", () => {
  it("counts the vendor's replies, never the customer's own messages", () => {
    // Just submitted: the body is the thread's first message; nothing is new.
    expect(w.itemNews(item({ reply_count: 1 }), 0)).toEqual({ reply: false, status: false });
    // They followed up twice after reading Sam's reply: still nothing new to them.
    expect(w.itemNews(item({ reply_count: 4, vendor_reply_count: 1 }), 1).reply).toBe(false);
    // Sam answered again since they last opened it.
    expect(w.itemNews(item({ reply_count: 5, vendor_reply_count: 2 }), 1).reply).toBe(true);
    // Never opened on this device: a vendor reply is news.
    expect(w.itemNews(item({ vendor_reply_count: 1 })).reply).toBe(true);
  });

  it("seeds a returning customer's marks from the replies so far, so the update lights nothing", () => {
    const list = [
      item({ short_id: "FB-1", reply_count: 3, vendor_reply_count: 1 }),
      item({ short_id: "FB-2", reply_count: 4, vendor_reply_count: 2 }),
      item({ short_id: "FB-3", reply_count: 1 }), // no vendor reply yet
    ];
    const seen = w.seedSeen(list);
    expect(seen).toEqual({ "FB-1": 1, "FB-2": 2, "FB-3": 0 });
    for (const it of list) expect(w.itemNews(it, seen[it.short_id]).reply, it.short_id).toBe(false);
    // The next vendor reply is news again.
    expect(w.itemNews({ ...list[2]!, vendor_reply_count: 1 }, seen["FB-3"]).reply).toBe(true);
  });

  it("flags a status move worth interrupting for until it's seen", () => {
    expect(w.itemNews(item({ status: "shipped" }), 0, "planned").status).toBe(true);
    expect(w.itemNews(item({ status: "shipped" }), 0, "shipped").status).toBe(false);
    expect(w.itemNews(item({ status: "review" }), 0, "open").status).toBe(false); // bookkeeping
  });

  it("names the vendor only when their reply is the latest event", () => {
    const at = "2026-10-07T10:00:00.000Z";
    const replied = item({ vendor_reply_count: 1, last_vendor_reply_at: at, last_event: { kind: "reply", at, author_name: "Sam" } });
    expect(w.newsPhrase(replied, { reply: true, status: false })).toBe("Sam replied");
    // The customer wrote after Sam, so the latest reply (and name) is theirs.
    const after = { ...replied, last_event: { kind: "reply" as const, at: "2026-10-07T11:00:00.000Z", author_name: "Maya" } };
    expect(w.newsPhrase(after, { reply: true, status: false })).toBe("New reply");
    // Replied, then shipped: the latest event is the outcome.
    const shipped = { ...replied, status: "shipped" as const, last_event: { kind: "status" as const, at: "2026-10-07T12:00:00.000Z" } };
    expect(w.newsPhrase(shipped, { reply: true, status: true })).toBe("Shipped: Dark mode");
  });
});

describe("status reason", () => {
  it("shows the vendor's why, not reopen bookkeeping or the customer's own close note", () => {
    expect(w.statusReason(item({ status: "declined", status_reason: " Not in v2. " }))).toBe("Not in v2.");
    expect(w.statusReason(item({ status: "deferred", status_reason: "Revisiting in Q3." }))).toBe("Revisiting in Q3.");
    expect(w.statusReason(item({ status: "open", status_reason: "Unmerged" }))).toBe("");
    expect(w.statusReason(item({ status: "resolved", status_reason: "All set, thanks" }))).toBe("");
    expect(w.statusReason(item({ status: "shipped", status_reason: null }))).toBe("");
  });
});

describe("page URLs (submissions, crumb.track and the recorder)", () => {
  it("lose the same secrets in the browser as on the server", () => {
    const urls = [
      "https://app.acme.co/settings?tab=billing&access_token=abc123#usage",
      "https://maya:hunter2@app.acme.co/cb?code=xyz&state=ok",
      "https://app.acme.co/cb#id_token=eyJ.x.y&expires_in=3600",
      "https://app.acme.co/p;jsessionid=ABC?q=dark+mode&X-Amz-Signature=deadbeef",
      "https://app.acme.co/join?invite_code=K3Y&X-Api-Key=k1&sig=s&lang=en",
      "https://app.acme.co/reports/42",
    ];
    for (const u of urls) expect(redactUrl(u)).toBe(redactContextUrl(u));
    expect(redactUrl(urls[0]!)).toBe("https://app.acme.co/settings?tab=billing&access_token=[redacted]#usage");
    expect(redactUrl(urls[1]!)).toBe("https://app.acme.co/cb?code=[redacted]&state=ok");
    expect(redactUrl(urls[4]!)).toBe("https://app.acme.co/join?invite_code=[redacted]&X-Api-Key=[redacted]&sig=[redacted]&lang=en");
  });

  it("go through one redactor in the widget and its recorder", () => {
    const src = (f: string) => readFileSync(resolve(__dirname, "../../../widget/src", f), "utf8");
    for (const f of ["widget.ts", "widget-record.ts"]) {
      expect(src(f), f).toMatch(/import \{[^}]*\bredactUrl\b[^}]*\} from "\.\/redact"/);
      expect(src(f), f).not.toMatch(/function redact(Url|Pairs)|SECRET_(KEY|PARAM) =/);
    }
  });
});

describe("markup", () => {
  it("keeps a name with quotes inside its attribute", () => {
    // Names reach aria-label="Remove …" in the Admin tab (and the trusted-email path is unauthenticated).
    expect(w.escapeHtml(`Eve" onfocus="alert(1)`)).toBe("Eve&quot; onfocus=&quot;alert(1)");
    expect(w.escapeHtml("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  });
});

describe("vendor accent", () => {
  const luminance = (hex: string) => [0, 2, 4].reduce((sum, i, j) => {
    const v = parseInt(hex.slice(1 + i, 3 + i), 16) / 255;
    return sum + [0.2126, 0.7152, 0.0722][j]! * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  }, 0);
  const onWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);

  it("fills the primary button only where white text on it reads at 4.5:1", () => {
    expect(onWhite("#767676")).toBeGreaterThanOrEqual(4.5); // the lightest gray that passes
    expect(onWhite("#777777")).toBeLessThan(4.5);
    for (const c of ["#767676", "#777777", "#E27D3A", "#1C1A17", "#2563EB", "#FFD400", "#FFFFFF"]) {
      expect(w.readableAccent(c), c).toBe(onWhite(c) >= 4.5 ? c : null);
    }
    expect(w.readableAccent("#E27D3A")).toBeNull(); // the default ember keeps the panel's ink
    expect(w.readableAccent(" #36f ")).toBe("#3366ff");
    for (const bad of ["red", "#12345", "rgb(0,0,0)", "", null, undefined]) expect(w.readableAccent(bad)).toBeNull();
  });
});
