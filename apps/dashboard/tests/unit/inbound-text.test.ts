import { describe, it, expect } from "vitest";
import { captureFromEmail, normalizeMessageId } from "@/lib/inbound-text";

// A forward sent to the capture address is the customer's message, not the
// teammate's who forwarded it (audit #54): the capture keeps the forwarded
// words, is attributed to the sender in the forwarded header block, and names
// the forwarder in a note line. An ordinary reply keeps its quote stripping.

const sam = "Sam Lee <sam@vendor.co>";
const byline = "Forwarded by Sam Lee (sam@vendor.co)";

describe("captureFromEmail", () => {
  it("reads Gmail, Outlook and Apple Mail forwards as the original sender's message", () => {
    const gmail = [
      "Can we get this in front of the team?",
      "",
      "---------- Forwarded message ---------",
      "From: Maya Chen <maya@globex.com>",
      "Date: Mon, Oct 5, 2026 at 9:14 AM",
      "Subject: CSV export is broken",
      "To: Sam Lee <sam@vendor.co>",
      "",
      "",
      "Hi Sam,",
      "The CSV export has failed since Friday.",
      "",
      "On Fri, Oct 2, 2026 at 3:00 PM Sam Lee <sam@vendor.co> wrote:",
      "> Could you try again?",
    ].join("\n");
    expect(captureFromEmail({ from: sam, subject: "Fwd: CSV export is broken", text: gmail })).toEqual({
      fromEmail: "maya@globex.com",
      fromName: "Maya Chen",
      subject: "CSV export is broken",
      body: `${byline}\n\nHi Sam,\nThe CSV export has failed since Friday.`,
    });

    // Outlook says "forward" only in the subject; its header block comes in
    // both the current and the old [mailto:] shape.
    const outlook = [
      "FYI, see below.",
      "",
      "________________________________",
      "From: Chen, Maya <maya@globex.com<mailto:maya@globex.com>>",
      "Sent: Monday, October 5, 2026 9:14 AM",
      "To: Sam Lee <sam@vendor.co>",
      "Subject: SSO for the EU workspace",
      "",
      "We need SAML SSO before renewal.",
    ].join("\r\n");
    const sso = { fromEmail: "maya@globex.com", fromName: "Chen, Maya", subject: "SSO for the EU workspace", body: `${byline}\n\nWe need SAML SSO before renewal.` };
    expect(captureFromEmail({ from: sam, subject: "FW: SSO for the EU workspace", text: outlook })).toEqual(sso);
    const legacy = outlook
      .replace("________________________________", "-----Original Message-----")
      .replace("Chen, Maya <maya@globex.com<mailto:maya@globex.com>>", "Chen, Maya [mailto:maya@globex.com] ");
    expect(captureFromEmail({ from: sam, subject: "FW: SSO for the EU workspace", text: legacy })).toEqual(sso);

    // Apple Mail quotes the message it forwards.
    const apple = [
      "Sent from my iPhone",
      "",
      "Begin forwarded message:",
      "",
      "> From: \"Maya Chen\" <maya@globex.com>",
      "> Subject: Dark mode please",
      "> Date: October 5, 2026 at 9:14:00 AM GMT+2",
      "> To: Sam Lee <sam@vendor.co>",
      "> ",
      "> Our team works late. A dark theme would help.",
    ].join("\n");
    expect(captureFromEmail({ from: sam, subject: "Fwd: Dark mode please", text: apple })).toEqual({
      fromEmail: "maya@globex.com",
      fromName: "Maya Chen",
      subject: "Dark mode please",
      body: `${byline}\n\nOur team works late. A dark theme would help.`,
    });

    // Support forwarded it to a PM, who forwarded it here: still Maya's.
    const chain = [
      "Adding this one.",
      "---------- Forwarded message ---------",
      "From: Support <support@vendor.co>",
      "Date: Tue, Oct 6, 2026 at 10:00 AM",
      "Subject: Fwd: CSV export is broken",
      "To: Pat <pat@vendor.co>",
      "",
      "Customer report, see below.",
      "",
      gmail.slice(gmail.indexOf("----------")),
    ].join("\n");
    expect(captureFromEmail({ from: "Pat <pat@vendor.co>", subject: "Fwd: Fwd: CSV export is broken", text: chain })).toMatchObject({
      fromEmail: "maya@globex.com",
      subject: "CSV export is broken",
      body: "Forwarded by Pat (pat@vendor.co)\n\nHi Sam,\nThe CSV export has failed since Friday.",
    });
  });

  it("keeps an ordinary reply the sender's own words above the quoted history", () => {
    // Outlook quotes a reply with the same header block it forwards with.
    const reply = [
      "Still failing today.",
      "",
      "________________________________",
      "From: Sam Lee <sam@vendor.co>",
      "Sent: Monday, October 5, 2026 9:14 AM",
      "Subject: CSV export is broken",
      "",
      "Could you try again?",
    ].join("\r\n");
    expect(captureFromEmail({ from: "Maya Chen <maya@globex.com>", subject: "RE: CSV export is broken", text: reply })).toEqual({
      fromEmail: "maya@globex.com",
      fromName: "Maya Chen",
      subject: "RE: CSV export is broken",
      body: "Still failing today.",
    });
    // A forward marker inside quoted history doesn't make the reply a forward.
    const quoting = "Thanks, that helps.\nOn Mon, Sam wrote:\n> ---------- Forwarded message ---------\n> From: Bob <bob@globex.com>";
    expect(captureFromEmail({ from: "maya@globex.com", subject: "Re: Fwd: Export", text: quoting })).toEqual({
      fromEmail: "maya@globex.com", fromName: null, subject: "Re: Fwd: Export", body: "Thanks, that helps.",
    });
  });
});

describe("normalizeMessageId", () => {
  it("gives one key per message, whatever the provider wraps it in", () => {
    expect(normalizeMessageId(" <CA+abc@mail.gmail.com> ")).toBe("CA+abc@mail.gmail.com");
    expect(normalizeMessageId("CA+abc@mail.gmail.com")).toBe("CA+abc@mail.gmail.com");
    expect(normalizeMessageId("<>")).toBeNull();
    expect(normalizeMessageId(42)).toBeNull();
    expect(normalizeMessageId(`<${"x".repeat(5000)}@mail>`)).toHaveLength(512);
  });
});
