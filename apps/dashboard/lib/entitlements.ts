import "server-only";
import type { Workspace } from "@crumb/db";
import { isCloud, isSelfHost } from "./tier";
// Use the @/ specifier (not "./stripe") so the community-edition webpack alias
// in next.config swaps this for the SDK-free stub. A relative import here would
// drag the real lib/stripe.ts (and the `stripe` package) into every bundle,
// since entitlements is imported app-wide.
import { isActiveStatus } from "@/lib/stripe";

// Per-workspace feature entitlements. The tier gate (`isCloud()`) answers
// "is this deployment the hosted product?"; this layer answers "is THIS
// workspace allowed to use feature X?" — driven by its Stripe plan.
//
// The billing columns (`workspaces.plan_id`, `subscription_status`) are kept
// in sync by the Stripe webhook (app/api/v1/stripe/webhook). `plan_id` comes
// from the price's lookup_key ("team" | "growth"); unknown / unset → "free".
//
// Policy (see lib/tier.ts header for the OSS-vs-Cloud rationale):
//   - AI + Session Record are hard Cloud-only AND plan-gated — the paid
//     differentiators. `hasFeature` requires isCloud(), so they're always
//     off on self-host regardless of BYO keys.
//   - Integrations (Slack/Linear/Jira/GitHub) are capability-gated: self-host
//     unlocks them by bringing their own OAuth app creds (the `*Configured()`
//     checks). On Cloud they additionally require the "integrations" plan
//     feature, since Cloud supplies the shared OAuth apps. Use
//     `integrationsAllowed()` for that combined rule.

export type Feature = "ai" | "session_record" | "integrations" | "usage_analytics";
export type Plan = "free" | "team" | "growth";

// Which features each plan unlocks. Tune freely as pricing evolves — this is
// the single source of truth for the plan→feature mapping.
const PLAN_FEATURES: Record<Plan, readonly Feature[]> = {
  free: [],
  team: ["ai", "integrations", "usage_analytics"],
  growth: ["ai", "integrations", "session_record", "usage_analytics"],
};

const KNOWN_PLANS = new Set<Plan>(["free", "team", "growth"]);

function normalizePlan(planId: string | null | undefined): Plan {
  if (planId && KNOWN_PLANS.has(planId as Plan)) return planId as Plan;
  // Unknown lookup_key or a raw Stripe price id we couldn't map → no paid
  // entitlements. Fail closed.
  return "free";
}

// The effective plan for a workspace, accounting for tier + subscription
// health. Self-host has no Cloud plan concept (always "free" here — its
// features come from the tier/creds gates, not this map). On Cloud, a
// lapsed/canceled/missing subscription collapses to "free".
export function workspacePlan(
  ws: Pick<Workspace, "planId" | "subscriptionStatus">,
): Plan {
  if (!isCloud()) return "free";
  if (!isActiveStatus(ws.subscriptionStatus)) return "free";
  return normalizePlan(ws.planId);
}

// True when the workspace's plan unlocks `feature` AND this is a Cloud
// deployment. Hard cloud-only by construction: self-host → always false.
export function hasFeature(
  ws: Pick<Workspace, "planId" | "subscriptionStatus">,
  feature: Feature,
): boolean {
  if (!isCloud()) return false;
  return PLAN_FEATURES[workspacePlan(ws)].includes(feature);
}

// Combined rule for third-party integrations. Self-host: allowed (the
// per-provider `*Configured()` creds check still gates actual availability).
// Cloud: requires the "integrations" plan feature.
export function integrationsAllowed(
  ws: Pick<Workspace, "planId" | "subscriptionStatus">,
): boolean {
  return isSelfHost() || hasFeature(ws, "integrations");
}

// Usage-event ingestion + the non-AI usage surfaces (account signals, churn,
// breadcrumb, initiative impact). Capability-gated like integrations: self-host
// gets it (it's just data, no AI cost; the surfaces render zeros when empty),
// Cloud requires the "usage_analytics" plan feature. The AI usage-query path
// gates separately on hasFeature(ws, "ai") and lives under ee/.
export function usageAnalyticsAllowed(
  ws: Pick<Workspace, "planId" | "subscriptionStatus">,
): boolean {
  return isSelfHost() || hasFeature(ws, "usage_analytics");
}

// All features the workspace currently has — handy for the billing page's
// "your plan unlocks…" display and for /me-style payloads.
export function workspaceFeatures(
  ws: Pick<Workspace, "planId" | "subscriptionStatus">,
): Feature[] {
  if (!isCloud()) return [];
  return [...PLAN_FEATURES[workspacePlan(ws)]];
}

// Exported for tests + the billing UI's plan comparison table.
export const PLAN_FEATURE_MAP = PLAN_FEATURES;
