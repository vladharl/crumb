import { describe, expect, it } from "vitest";
import { checkinLinks, checkinPayload } from "@/lib/checkin";
import { verifyReplyToken } from "@/lib/reply-token";
import { renderCheckinHtml, renderCheckinText } from "@/lib/email/template";

const id = "7b9c1f5b-e037-4f0f-a883-454274100bfc";

describe("check-in email", () => {
  const links = checkinLinks("https://crumb.test", id, "secret-a");

  it("has one signed link per answer, valid only for that member and workspace", () => {
    expect(links.map((l) => new URL(l.url).searchParams.get("a"))).toEqual(["fit", "comparing", "chat"]);
    const t = new URL(links[0]!.url).searchParams.get("t")!;
    expect(verifyReplyToken(checkinPayload(id), t, "secret-a")).toBe(true);
    expect(verifyReplyToken(checkinPayload(id), t, "secret-b")).toBe(false);
    expect(verifyReplyToken(checkinPayload("00000000-0000-0000-0000-000000000000"), t, "secret-a")).toBe(false);
  });

  it("renders every button, escapes names, and has no em-dashes", () => {
    const v = { firstName: "<b>Pr", workspaceName: "Sticky & Co", buttons: links };
    const html = renderCheckinHtml(v);
    for (const l of links) expect(html).toContain(l.url.replace(/&/g, "&amp;"));
    expect(html).toContain("&lt;b&gt;Pr");
    expect(html + renderCheckinText(v)).not.toContain("—");
  });
});
