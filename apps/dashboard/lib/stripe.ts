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
    appInfo: { name: "Crumb", url: "https://usecrumb.xyz" },
  });
  return cached;
}

export function stripeConfigured(): boolean {
  return stripeClient() !== null;
}

// Read-only env getters, centralized so callers don't sprinkle process.env.
export const STRIPE_PRICE_ID      = () => process.env.STRIPE_PRICE_ID?.trim() ?? null;
export const STRIPE_WEBHOOK_SECRET = () => process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? null;
export const STRIPE_PORTAL_RETURN_URL = (defaultUrl: string) =>
  process.env.STRIPE_PORTAL_RETURN_URL?.trim() || defaultUrl;

// Subscription statuses we treat as "the workspace has paid access".
// Trial counts; past_due gets a grace period (the webhook flips to
// unpaid → canceled when Stripe finally gives up).
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
export function isActiveStatus(s: string | null | undefined): boolean {
  return !!s && ACTIVE_STATUSES.has(s);
}
