"use server";

import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { requireSession } from "@/lib/auth";
import {
  stripeClient, STRIPE_PORTAL_RETURN_URL, priceIdForPlan, stripeKeyMisconfigured, isActiveStatus,
  type PaidPlan, type BillingInterval,
} from "@/lib/stripe";
import { isCloud } from "@/lib/tier";
import { planDisplayName } from "@/lib/entitlements";
import { originFromHeaders } from "@/lib/origin";
import { log } from "@/lib/log";

export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const PAID_PLANS = new Set<PaidPlan>(["team", "growth"]);
const INTERVALS = new Set<BillingInterval>(["month", "year"]);
const STRIPE_UNREACHABLE = "Couldn't reach Stripe just now. Try again in a moment.";

// Vendor admin picks a plan + interval. We ensure a Stripe customer exists for
// the workspace (creates one on first run, stores the id), then mint a Checkout
// session for the matching price (resolved by its lookup_key). Success lands on
// /settings/billing?stripe=success, which waits for the webhook to write the
// subscription; cancel carries the plan + interval back so the pick survives.
export async function createCheckoutSession(
  plan: PaidPlan,
  interval: BillingInterval,
): Promise<CheckoutResult> {
  if (!isCloud()) return { ok: false, error: "Billing is a Cloud-only feature." };
  if (!PAID_PLANS.has(plan) || !INTERVALS.has(interval)) {
    return { ok: false, error: "Pick a valid plan and billing interval." };
  }
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "Only admins can manage billing." };

  const stripe = stripeClient();
  if (!stripe) return { ok: false, error: "Stripe isn't configured on this deployment." };
  // A test key on a live deployment lets checkout succeed without ever charging.
  // Don't block (operators may test deliberately), but make it loud in the logs.
  if (stripeKeyMisconfigured()) {
    log.warn("stripe checkout on a test key in Cloud, checkout will not charge", {
      workspaceId: workspace.id,
      plan,
      interval,
    });
  }
  const origin = originFromHeaders(headers());
  if (!origin) return { ok: false, error: "Could not determine host." };

  // A Stripe error (outage, network, a rejected call) comes back as a result
  // the picker shows, never as a throw that leaves it stuck.
  try {
    const priceId = await priceIdForPlan(plan, interval);
    if (!priceId) {
      return { ok: false, error: `No Stripe price found for ${planDisplayName(plan)} (${interval === "year" ? "annual" : "monthly"}).` };
    }

    // Reuse the workspace's customer if we've created one before; otherwise
    // create now and persist so future portal/checkout sessions hit the
    // same Stripe customer record.
    let customerId = workspace.stripeCustomerId;
    if (customerId) {
      // The webhook can lag the redirect back from Checkout, so the page may
      // still look unpaid. Ask Stripe directly so a second click (stale tab,
      // back button) can't start a second subscription. If Stripe can't say,
      // this stops at the catch below rather than risk one.
      const subs = await stripe.subscriptions.list({ customer: customerId, limit: 10 });
      if (subs.data.some(sub => isActiveStatus(sub.status))) {
        return { ok: false, error: "This workspace already has a subscription. It can take a minute to show here, so refresh shortly." };
      }
    } else {
      const customer = await stripe.customers.create({
        email: user.email,
        name: workspace.name,
        metadata: { workspace_id: workspace.id, workspace_slug: workspace.slug },
      });
      customerId = customer.id;
      await db.update(workspaces)
        .set({ stripeCustomerId: customerId })
        .where(eq(workspaces.id, workspace.id));
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/settings/billing?stripe=success`,
      cancel_url:  `${origin}/settings/billing?stripe=cancel&plan=${plan}&interval=${interval}`,
      allow_promotion_codes: true,
      // We're the merchant of record (Stripe-direct), so charge the right
      // VAT/sales tax. automatic_tax needs the customer's address, so collect it at
      // checkout and persist it onto the customer for the portal + invoices.
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      customer_update: { address: "auto", name: "auto" },
      tax_id_collection: { enabled: true },
      metadata: { workspace_id: workspace.id, workspace_slug: workspace.slug, plan },
      subscription_data: { metadata: { workspace_id: workspace.id, plan } },
    });

    if (!session.url) return { ok: false, error: "Stripe did not return a checkout URL." };
    return { ok: true, url: session.url };
  } catch (err) {
    log.error("stripe checkout failed", { scope: "crumb/stripe", workspaceId: workspace.id, err });
    return { ok: false, error: STRIPE_UNREACHABLE };
  }
}

// Active subscribers open the Stripe Customer Portal: "Manage" for invoices,
// payment method and cancellation, and "Upgrade" (changePlan) straight into
// its plan-change flow for the current subscription, so a subscriber moves
// plans instead of buying a second one. Return URL brings them back to
// /settings/billing.
export async function createPortalSession(changePlan?: boolean): Promise<CheckoutResult> {
  if (!isCloud()) return { ok: false, error: "Billing is a Cloud-only feature." };
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "Only admins can manage billing." };

  const stripe = stripeClient();
  if (!stripe) return { ok: false, error: "Stripe isn't configured on this deployment." };
  if (!workspace.stripeCustomerId) {
    return { ok: false, error: "This workspace has no subscription yet. Pick a plan to get started." };
  }

  const origin = originFromHeaders(headers());
  if (!origin) return { ok: false, error: "Could not determine host." };

  const portal = { customer: workspace.stripeCustomerId, return_url: STRIPE_PORTAL_RETURN_URL(`${origin}/settings/billing`) };
  if (changePlan === true && workspace.stripeSubscriptionId) {
    // Stripe refuses the flow when the portal's settings don't allow plan
    // changes; the portal itself opens instead.
    try {
      const flow = await stripe.billingPortal.sessions.create({
        ...portal,
        flow_data: { type: "subscription_update", subscription_update: { subscription: workspace.stripeSubscriptionId } },
      });
      return { ok: true, url: flow.url };
    } catch (err) {
      log.warn("stripe plan-change flow unavailable, opening the portal", { scope: "crumb/stripe", workspaceId: workspace.id, err });
    }
  }

  try {
    const session = await stripe.billingPortal.sessions.create(portal);
    return { ok: true, url: session.url };
  } catch (err) {
    log.error("stripe portal session failed", { scope: "crumb/stripe", workspaceId: workspace.id, err });
    return { ok: false, error: STRIPE_UNREACHABLE };
  }
}
