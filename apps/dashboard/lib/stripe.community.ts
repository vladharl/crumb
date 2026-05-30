import "server-only";

// Community-edition stub for lib/stripe.ts — aliased in via next.config when
// CRUMB_EDITION!=cloud, so the `stripe` SDK never enters the community bundle.
// Behaviour mirrors the unconfigured/self-host runtime (stripeClient() → null),
// which every caller already branches on. Keep this surface in sync with the
// real module (CI typechecks against the real one).

export function stripeClient(): null {
  return null;
}

export function stripeConfigured(): boolean {
  return false;
}

export const STRIPE_PRICE_ID = (): string | null => null;
export const STRIPE_WEBHOOK_SECRET = (): string | null => null;
export const STRIPE_PORTAL_RETURN_URL = (defaultUrl: string): string => defaultUrl;

// Pure helper (no SDK) — also consumed by lib/entitlements.ts, which ships in
// every edition, so keep the real logic here.
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
export function isActiveStatus(s: string | null | undefined): boolean {
  return !!s && ACTIVE_STATUSES.has(s);
}
