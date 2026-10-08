import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { OutgoingEmail } from "@/lib/email/provider";

// Capture what lib/email hands the provider (stdout is picked when no provider is set).
const sent = vi.hoisted(() => [] as OutgoingEmail[]);
vi.mock("@/lib/email/stdout", () => ({
  stdoutProvider: {
    name: "stdout",
    send: async (m: OutgoingEmail) => { sent.push(m); return { ok: true as const, providerMessageId: null }; },
  },
}));

import {
  sendReplyNotification, sendStatusChangeNotification, sendRoadmapUpdateNotification,
  sendShippedAnnouncement, sendInvite, sendMagicLink, sendSignupVerify, sendCustomerReplyNotification,
} from "@/lib/email";

const last = () => sent[sent.length - 1]!;
const item = { to: "ana@acme.co", workspaceName: "Acme", vendorName: "Lina", itemShortId: "FB-12", itemTitle: "Export to CSV" };
const status = (toStatus: string, extra: object = {}) =>
  sendStatusChangeNotification({ ...item, fromStatus: "review", toStatus, ...extra });
const unsub = "https://feedback.acme.test/api/v1/unsubscribe?u=1&t=abc&scope=status";

beforeAll(() => {
  delete process.env.CRUMB_EMAIL_PROVIDER;
  process.env.CRUMB_EMAIL_FROM = "Crumb <crumb@mail.example.com>";
});
beforeEach(() => {
  delete process.env.CRUMB_APP_URL;
  delete process.env.CRUMB_INBOUND_DOMAIN;
});

describe("customer emails", () => {
  it("lead subjects with the outcome and drop internal ids", async () => {
    const want: Record<string, string> = {
      shipped: "Shipped: Export to CSV",
      planned: "Planned: Export to CSV",
      progress: "In progress: Export to CSV",
      declined: "Won’t ship: Export to CSV",
      deferred: "Set aside: Export to CSV",
    };
    for (const [s, subject] of Object.entries(want)) {
      await status(s);
      expect(last().subject).toBe(subject);
    }
    await sendReplyNotification({ ...item, replyBody: "On it." });
    expect(last().subject).toBe("Lina replied: Export to CSV");
    await sendShippedAnnouncement({ to: item.to, workspaceName: "Acme", initiativeName: "Dark mode", title: "Dark mode", body: "", reason: "asked" });
    expect(last().subject).toBe("Shipped: Dark mode");
    await sendRoadmapUpdateNotification({ to: item.to, workspaceName: "Acme", initiativeName: "Dark mode", change: "moved to Now" });
    expect(last().subject).toBe("Moved to Now: Dark mode");
  });

  it("come from the vendor via Crumb, from noreply@ unless they can reply, with a text mark", async () => {
    await status("planned", { accent: "#3366FF" });
    expect(last().from).toBe('"Acme via Crumb" <noreply@mail.example.com>');
    expect(last().html).toContain("color:#3366FF");
    expect(last().html).not.toContain("<svg");

    await status("planned", { inboundReplyAddress: "reply+FB-12.tok@reply.acme.test" });
    expect(last().from).toBe('"Acme via Crumb" <crumb@mail.example.com>');
    await sendReplyNotification({ ...item, replyBody: "Hi", inboundReplyAddress: "reply+FB-12.tok@reply.acme.test" });
    expect(last().from).toBe('"Acme via Crumb" <crumb@mail.example.com>');
    await sendRoadmapUpdateNotification({ to: item.to, workspaceName: "Acme", initiativeName: "Dark mode", change: "moved to Now" });
    expect(last().from).toBe('"Acme via Crumb" <noreply@mail.example.com>');

    await sendStatusChangeNotification({ ...item, workspaceName: 'Acme "Labs"\nInc', fromStatus: null, toStatus: "planned", accent: "red;x:url(y)" });
    expect(last().from).toBe('"Acme Labs Inc via Crumb" <noreply@mail.example.com>');
    expect(last().html).not.toContain("url(y)");
  });

  it("build the footer link from CRUMB_APP_URL and drop it when unset", async () => {
    process.env.CRUMB_APP_URL = "https://feedback.acme.test/";
    await status("shipped");
    expect(last().html).toContain('Sent via <a href="https://feedback.acme.test"');
    expect(last().text).toContain("Sent via Crumb: https://feedback.acme.test");

    delete process.env.CRUMB_APP_URL;
    await status("shipped");
    expect(last().html).toContain("Sent via Crumb.");
    expect(last().html).not.toContain("Sent via <a");
    for (const m of sent) expect(m.html).not.toContain("localhostlabs");
  });

  it("never dead-end: link the Feedback tab, give directions, offer reply-by-email, keep the whole reply", async () => {
    const long = "word ".repeat(400).trim();
    await sendReplyNotification({ ...item, replyBody: long });
    expect(last().text).toContain(long);
    expect(last().text).toContain("Open Acme's Feedback tab to read and reply.");
    expect(last().text).not.toContain("Reply to this email");

    await sendReplyNotification({
      ...item, replyBody: "Done.", productUrl: "https://app.acme.test/",
      inboundReplyAddress: "reply+FB-12.tok@reply.acme.test",
    });
    expect(last().replyTo).toBe("reply+FB-12.tok@reply.acme.test");
    expect(last().html).toContain('href="https://app.acme.test/?crumb_open=FB-12"');
    expect(last().html).toContain(">Open the Feedback tab<");
    expect(last().text).toContain("Reply to this email to answer.");

    // No Product URL: the hosted read-only thread. A Product URL still wins.
    const view = "https://feedback.acme.test/t/FB-12/tok";
    await sendReplyNotification({ ...item, replyBody: "Done.", viewUrl: view });
    expect(last().html).toContain(`href="${view}"`);
    expect(last().html).toContain(">View the conversation<");
    expect(last().text).toContain(`View the conversation: ${view}`);
    await status("planned", { productUrl: "https://app.acme.test/", viewUrl: view });
    expect(last().html).not.toContain(view);

    // An attachment-only reply doesn't end its line on a dangling colon.
    await sendReplyNotification({ ...item, replyBody: "" });
    expect(last().text.split("\n")[0]).toBe('Lina replied to your feedback on "Export to CSV".');
  });

  it("carry one-click unsubscribe and per-item threading headers", async () => {
    await status("shipped", { unsubscribeUrl: unsub });
    const a = last().headers!;
    expect(a["List-Unsubscribe"]).toBe(`<${unsub}>`);
    expect(a["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    // https only, even with inbound mail wired: nothing applies a mailto unsubscribe.
    process.env.CRUMB_INBOUND_DOMAIN = "reply.acme.test";
    await sendReplyNotification({ ...item, replyBody: "Hi", unsubscribeUrl: unsub });
    const b = last().headers!;
    expect(b["List-Unsubscribe"]).toBe(`<${unsub}>`);

    // Same item, same thread root; every email keeps its own Message-ID.
    expect(b["In-Reply-To"]).toBe(a["In-Reply-To"]);
    expect(b.References).toBe(a["In-Reply-To"]);
    expect(b["Message-ID"]).not.toBe(a["Message-ID"]);
    expect(a["Message-ID"]).toMatch(/^<[^@\s]+@mail\.example\.com>$/);

    await status("planned", { itemShortId: "FB-13" });
    expect(last().headers!["In-Reply-To"]).not.toBe(a["In-Reply-To"]);
    expect(last().headers!["List-Unsubscribe"]).toBeUndefined();
    await status("planned", { workspaceName: "Globex" });
    expect(last().headers!["In-Reply-To"]).not.toBe(a["In-Reply-To"]);

    // A roadmap move and the shipped announcement for one initiative share a
    // thread, even when the changelog entry's title was edited.
    await sendRoadmapUpdateNotification({ to: item.to, workspaceName: "Acme", initiativeName: "Dark mode", change: "moved to Now" });
    const roadmapRoot = last().headers!["In-Reply-To"];
    await sendShippedAnnouncement({ to: item.to, workspaceName: "Acme", initiativeName: "Dark mode", title: "Dark mode is here", body: "", reason: "follow" });
    expect(last().headers!["In-Reply-To"]).toBe(roadmapRoot);
  });

  it("give shipped its own email with paragraphs and the right reason", async () => {
    const body = "Dark mode is here.\n\nFind it under Settings.";
    await sendShippedAnnouncement({ to: item.to, workspaceName: "Acme", initiativeName: "Dark mode", title: "Dark mode", body, reason: "asked", productUrl: "https://app.acme.test/" });
    expect(last().html).toContain("Shipped: Dark mode");
    expect(last().html.match(/<p style="margin:0 0 12px/g)).toHaveLength(2);
    expect(last().text).toContain("because you asked Acme for this.");
    expect(last().text).toContain("Open Acme: https://app.acme.test/");

    await sendShippedAnnouncement({ to: item.to, workspaceName: "Acme", initiativeName: "Dark mode", title: "Dark mode", body: "", reason: "follow" });
    expect(last().text).toContain("It's live now.");
    expect(last().text).toContain("because you follow this on Acme's roadmap.");
  });

  it("keep em-dashes out of everything a customer reads", () => {
    for (const m of sent) for (const part of [m.subject, m.html, m.text]) expect(part).not.toContain("—");
  });
});

describe("team invite email", () => {
  it("says who invited you to what, with one sign-in button and the expiry", async () => {
    const link = "https://crumb.acme.test/login/verify?token=t0k";
    // Printed by the stdout provider, it wasn't emailed, so the invite form
    // mustn't say it was.
    expect(await sendInvite({ to: "dev@acme.co", link, ttlMinutes: 7 * 24 * 60, workspaceName: "Acme", inviterName: "Dana" })).toBe(false);
    const m = last();
    expect(m.subject).toBe("Dana invited you to Acme on Crumb");
    expect(m.text).toContain("Crumb is where Acme keeps customer feedback");
    expect(m.text).toContain(link);
    expect(m.text).toContain("expires in 7 days");
    expect(m.html.match(/border-radius:8px;background:#4A2E1F/g)).toHaveLength(1);
    expect(m.html).toContain(`href="${link}"`);
    expect(m.subject + m.html + m.text).not.toContain("—");
  });
});

describe("sign-in, signup and teammate emails", () => {
  it("use a text mark, since Gmail and Outlook drop inline SVG", async () => {
    const link = "https://crumb.acme.test/x";
    await sendMagicLink({ to: "dev@acme.co", link, ttlMinutes: 15 });
    await sendSignupVerify({ to: "dev@acme.co", link, ttlMinutes: 30, workspaceName: "Acme" });
    await sendCustomerReplyNotification({
      to: "dev@acme.co", workspaceName: "Acme", customerName: "Ana", accountName: "Initech",
      itemShortId: "FB-12", itemTitle: "Export to CSV", replyBody: "Still broken.",
    });
    for (const m of sent.slice(-3)) {
      expect(m.html).not.toContain("<svg");
      expect(m.html).toContain("&#9679;");
    }
  });
});
