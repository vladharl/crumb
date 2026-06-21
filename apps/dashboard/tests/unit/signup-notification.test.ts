import { describe, it, expect } from "vitest";
import {
  renderSignupNotificationHtml,
  renderSignupNotificationText,
} from "@/lib/email/template";

const base = {
  workspaceName: "Acme Inc.",
  adminName: "Jane Doe",
  adminEmail: "jane@acme.co",
  slug: "acme",
  dashboardUrl: "https://crumb.example.com",
};

describe("renderSignupNotification", () => {
  it("includes the workspace, admin name, email, and slug in both renderings", () => {
    const html = renderSignupNotificationHtml(base);
    const text = renderSignupNotificationText(base);
    for (const out of [html, text]) {
      expect(out).toContain("Acme Inc.");
      expect(out).toContain("Jane Doe");
      expect(out).toContain("jane@acme.co");
      expect(out).toContain("acme");
    }
  });

  it("renders the Open Crumb link only when a dashboardUrl is given", () => {
    expect(renderSignupNotificationHtml(base)).toContain("https://crumb.example.com");
    expect(renderSignupNotificationText(base)).toContain("https://crumb.example.com");
    const without = { ...base, dashboardUrl: null };
    expect(renderSignupNotificationHtml(without)).not.toContain("Open Crumb</a>");
  });

  it("escapes user-controlled fields in the HTML (no injection in the ops email)", () => {
    const html = renderSignupNotificationHtml({
      ...base,
      workspaceName: "<script>alert(1)</script>",
      adminName: "Bad & Co <b>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Bad &amp; Co &lt;b&gt;");
  });
});
