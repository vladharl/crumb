import "server-only";
import Stripe from "stripe";

// Lazy client — we don't want module import to throw on self-host where
// Stripe creds are absent. Each helper that needs the client calls
// stripeClient() which returns null when unconfigured.
let cached: Stripe | null | undefined;

export function stripeClient(): Stripe | null {
  if (cached !== undefined) return cached;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    cached = null;
    return null;
  }
  cached = new Stripe(key, {
    // Pinning the API version protects against silent breaking changes.
    // Track Stripe-Node's pinned default; bump deliberately after testing.
    apiVersion: "2026-04-22.dahlia",
    appInfo: { name: "Crumb", url: "https://crumb.localhostlabs.net" },
  });
  return cached;
}

export function stripeConfigured(): boolean {
  return stripeClient() !== null;
}

// Read-only env getters, centralized so callers don't sprinkle process.env.
export const STRIPE_WEBHOOK_SECRET = () => process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? null;
export const STRIPE_PORTAL_RETURN_URL = (defaultUrl: string) =>
  process.env.STRIPE_PORTAL_RETURN_URL?.trim() || defaultUrl;

// ─── plans × intervals ───────────────────────────────────────
// The purchasable plans and billing intervals the checkout offers. "free" is
// the default for a new workspace and isn't bought, so it's excluded here.
export type PaidPlan = "team" | "growth";
export type BillingInterval = "month" | "year";

// Each Stripe price carries a lookup_key of "<plan>_<monthly|annual>" — the
// single source of truth that ties a price to a plan + interval. The webhook
// reads the same key back to set workspaces.plan_id (see planIdFromLookupKey).
export function lookupKeyFor(plan: PaidPlan, interval: BillingInterval): string {
  return `${plan}_${interval === "year" ? "annual" : "monthly"}`;
}

// Map a price's lookup_key to our internal plan id. We key entitlements off the
// plan PREFIX only (interval is a billing detail, not a feature gate). Unknown
// / unset → "unknown" so entitlements fail closed to "free".
export function planIdFromLookupKey(lookupKey: string | null | undefined): string {
  const prefix = lookupKey?.split("_")[0];
  return prefix === "team" || prefix === "growth" ? prefix : "unknown";
}

// Resolve the Stripe price id for a (plan, interval) via its lookup_key.
// Cached per key for the process lifetime — prices are effectively static.
// Returns null when Stripe is unconfigured or no active price carries the key.
const priceIdCache = new Map<string, string>();
export async function priceIdForPlan(plan: PaidPlan, interval: BillingInterval): Promise<string | null> {
  const stripe = stripeClient();
  if (!stripe) return null;
  const key = lookupKeyFor(plan, interval);
  const cached = priceIdCache.get(key);
  if (cached) return cached;
  const res = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const price = res.data[0];
  if (!price) return null;
  priceIdCache.set(key, price.id);
  return price.id;
}

// Subscription statuses we treat as "the workspace has paid access".
// Trial counts; past_due gets a grace period (the webhook flips to
// unpaid → canceled when Stripe finally gives up).
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
export function isActiveStatus(s: string | null | undefined): boolean {
  return !!s && ACTIVE_STATUSES.has(s);
}
