import { describe, it, expect, vi } from "vitest";

// The checklist module also renders the server component; keep the unit test
// off the session/DB-backed clear action.
vi.mock("@/app/(app)/settings/sample-actions", () => ({ clearSampleData: vi.fn() }));

import { setupSteps, type SetupFacts } from "@/components/SetupChecklist";

const fresh: SetupFacts = {
  widgetInstalled: false,
  productUrl: false,
  teammates: 1,
  cloud: false,
  emailProvider: null,
  toolConnected: false,
  roadmapPublished: false,
};

const step = (f: SetupFacts, title: string) => setupSteps(f).find(s => s.title === title)!;

describe("setupSteps", () => {
  it("lists the journey in order, each step linking to where it's done", () => {
    expect(setupSteps(fresh).map(s => [s.title, s.href, s.done])).toEqual([
      ["Install the widget", "/settings/install", false],
      ["Set your Product URL", "/settings/branding", false],
      ["Invite your team", "/settings/team", false],
      ["Wire email delivery", "/settings#email-delivery", false],
      ["Connect a tool", "/settings/integrations", false],
      ["Publish your roadmap", "/initiatives", false],
    ]);
  });

  it("marks each step done from its fact", () => {
    const done = setupSteps({
      ...fresh,
      widgetInstalled: true,
      productUrl: true,
      teammates: 3,
      emailProvider: { name: "smtp", from: "loops@acme.test" },
      toolConnected: true,
      roadmapPublished: true,
    });
    expect(done.every(s => s.done)).toBe(true);
    expect(step({ ...fresh, teammates: 3 }, "Invite your team").detail).toBe("3 teammates can answer loops.");
  });

  it("counts email as handled on Cloud, and names a self-host provider", () => {
    expect(step({ ...fresh, cloud: true }, "Wire email delivery").done).toBe(true);
    const smtp = step({ ...fresh, emailProvider: { name: "smtp", from: "loops@acme.test" } }, "Wire email delivery");
    expect(smtp.done).toBe(true);
    expect(smtp.detail).toContain("smtp (from loops@acme.test)");
    expect(step(fresh, "Wire email delivery").done).toBe(false);
  });

  it("explains the Product URL in terms of customer emails", () => {
    expect(step(fresh, "Set your Product URL").detail).toMatch(/email/i);
  });

  it("never uses an em-dash in step copy", () => {
    const all = [fresh, { ...fresh, widgetInstalled: true, productUrl: true, teammates: 2, cloud: true, toolConnected: true, roadmapPublished: true }];
    for (const f of all) {
      for (const s of setupSteps(f)) expect(`${s.title} ${s.detail}`).not.toContain("—");
    }
  });
});
