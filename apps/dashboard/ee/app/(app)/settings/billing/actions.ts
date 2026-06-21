"use server";

import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { requireSession } from "@/lib/auth";
import {
  stripeClient, STRIPE_PORTAL_RETURN_URL, priceIdForPlan, stripeKeyMisconfigured,
  type PaidPlan, type BillingInterval,
} from "@/lib/stripe";
import { isCloud } from "@/lib/tier";
import { log } from "@/lib/log";

export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

function originFromHeaders(): string | null {
  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  if (!host) return null;
  return `${proto}://${host}`;
}

const PAID_PLANS = new Set<PaidPlan>(["team", "growth"]);
const INTERVALS = new Set<BillingInterval>(["month", "year"]);

// Vendor admin picks a plan + interval — we ensure a Stripe customer exists for
// the workspace (creates one on first run, stores the id), then mint a Checkout
// session for the matching price (resolved by its lookup_key). The session
// redirects back to /settings/billing where the webhook will have already
// written the subscription row before the redirect lands.
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
  // Don't block (operators may test deliberately) — make it loud in the logs.
  if (stripeKeyMisconfigured()) {
    log.warn("stripe checkout on a test key in Cloud — checkout will not charge", {
      workspaceId: workspace.id,
      plan,
      interval,
    });
  }
  const priceId = await priceIdForPlan(plan, interval);
  if (!priceId) return { ok: false, error: `No Stripe price found for the ${plan} (${interval === "year" ? "annual" : "monthly"}) plan.` };

  const origin = originFromHeaders();
  if (!origin) return { ok: false, error: "Could not determine host." };

  // Reuse the workspace's customer if we've created one before; otherwise
  // create now and persist so future portal/checkout sessions hit the
  // same Stripe customer record.
  let customerId = workspace.stripeCustomerId;
  if (!customerId) {
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
    cancel_url:  `${origin}/settings/billing?stripe=cancel`,
    allow_promotion_codes: true,
    // We're the merchant of record (Stripe-direct), so charge the right
    // VAT/sales tax. automatic_tax needs the customer's address — collect it at
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
}

// Active subscribers click "Manage" — open the Stripe Customer Portal
// (handles invoices, payment method, cancellation). Return URL brings
// them back to /settings/billing.
export async function createPortalSession(): Promise<CheckoutResult> {
  if (!isCloud()) return { ok: false, error: "Billing is a Cloud-only feature." };
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "Only admins can manage billing." };

  const stripe = stripeClient();
  if (!stripe) return { ok: false, error: "Stripe isn't configured on this deployment." };
  if (!workspace.stripeCustomerId) {
    return { ok: false, error: "No Stripe customer for this workspace yet — start with Upgrade." };
  }

  const origin = originFromHeaders();
  if (!origin) return { ok: false, error: "Could not determine host." };

  const session = await stripe.billingPortal.sessions.create({
    customer: workspace.stripeCustomerId,
    return_url: STRIPE_PORTAL_RETURN_URL(`${origin}/settings/billing`),
  });

  return { ok: true, url: session.url };
}
