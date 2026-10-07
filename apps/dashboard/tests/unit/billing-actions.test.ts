import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Billing server actions against a fake Stripe: a Stripe failure comes back as
// a result the page shows (never a throw that leaves the button spinning), and
// a subscriber's Upgrade opens the portal's plan change for their own
// subscription, or the portal itself when Stripe won't run that flow.

const h = vi.hoisted(() => ({
  stripe: {
    prices: { list: vi.fn() },
    subscriptions: { list: vi.fn() },
    customers: { create: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
  },
}));
vi.mock("stripe", () => ({ default: class { constructor() { return h.stripe; } } }));
vi.mock("@/lib/tier", () => ({ isCloud: () => true, isSelfHost: () => false }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => ({
    workspace: { id: "ws-1", slug: "acme", name: "Acme", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" },
    user: { id: "user-1", role: "admin", email: "lina@acme.test" },
  }),
}));
vi.mock("next/headers", () => ({ headers: () => new Headers({ host: "crumb.test" }) }));
vi.mock("@/lib/log", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
const { createCheckoutSession, createPortalSession } = await import("@/ee/app/(app)/settings/billing/actions");

afterEach(() => vi.clearAllMocks());
afterAll(() => vi.unstubAllEnvs());

describe("createCheckoutSession", () => {
  it("returns an error the picker shows when Stripe can't confirm there's no subscription yet", async () => {
    h.stripe.prices.list.mockResolvedValue({ data: [{ id: "price_team_annual" }] });
    h.stripe.subscriptions.list.mockRejectedValue(new Error("stripe down"));
    expect(await createCheckoutSession("team", "year")).toEqual({
      ok: false,
      error: "Couldn't reach Stripe just now. Try again in a moment.",
    });
    expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("createPortalSession", () => {
  const portalCall = (n: number) => h.stripe.billingPortal.sessions.create.mock.calls[n]![0];

  it("Upgrade opens the portal's plan change for the current subscription", async () => {
    h.stripe.billingPortal.sessions.create.mockResolvedValue({ url: "https://billing.stripe.test/flow" });
    expect(await createPortalSession(true)).toEqual({ ok: true, url: "https://billing.stripe.test/flow" });
    expect(portalCall(0)).toMatchObject({
      customer: "cus_1",
      flow_data: { type: "subscription_update", subscription_update: { subscription: "sub_1" } },
    });
  });

  it("falls back to the portal itself when Stripe refuses the plan-change flow", async () => {
    h.stripe.billingPortal.sessions.create
      .mockRejectedValueOnce(new Error("subscription updates are disabled"))
      .mockResolvedValueOnce({ url: "https://billing.stripe.test/portal" });
    expect(await createPortalSession(true)).toEqual({ ok: true, url: "https://billing.stripe.test/portal" });
    expect(portalCall(1)).not.toHaveProperty("flow_data");
  });

  it("Manage opens the plain portal, and a Stripe failure is a result, not a throw", async () => {
    h.stripe.billingPortal.sessions.create.mockRejectedValue(new Error("stripe down"));
    expect(await createPortalSession()).toEqual({ ok: false, error: "Couldn't reach Stripe just now. Try again in a moment." });
    expect(h.stripe.billingPortal.sessions.create).toHaveBeenCalledTimes(1);
    expect(portalCall(0)).not.toHaveProperty("flow_data");
  });
});
