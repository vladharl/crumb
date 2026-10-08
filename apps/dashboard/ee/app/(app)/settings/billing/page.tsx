import { Card, CardHead, Pill } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { isCloud } from "@/lib/tier";
import {
  stripeConfigured, stripeKeyMisconfigured, isActiveStatus, planPrices,
  type BillingInterval, type PaidPlan,
} from "@/lib/stripe";
import { PLAN_FEATURES, planDisplayName, workspacePlan, type Plan } from "@/lib/entitlements";
import { getUsageSummary, type UsageMetric } from "@/lib/usage";
import { PlanPicker, ManageButton, CheckoutReturn, FeatureList, type FeatureLine, type PlanCard } from "./BillingActions";

const USAGE_LABEL: Record<UsageMetric, string> = {
  ai: "AI operations",
  replay_bytes: "Session replay",
  usage_events: "Usage events",
};

// Each paid plan's card lists what it adds over the plan below it.
const UPGRADES: { id: PaidPlan; over: Plan }[] = [
  { id: "team", over: "free" },
  { id: "growth", over: "team" },
];

export const dynamic = "force-dynamic";

// A plan's customer-facing lines from PLAN_FEATURES. With `over`, only what the
// plan adds on top of that one: new features, or a bigger allowance.
function featureLines(plan: Plan, over?: Plan): FeatureLine[] {
  return PLAN_FEATURES
    .filter(f => f.plans.includes(plan))
    .filter(f => !over || !f.plans.includes(over) || f.limits?.[over] !== f.limits?.[plan])
    .map(f => ({ label: f.label, limit: f.limits?.[plan] }));
}

// Human-readable bytes for the replay-storage meter (1024-based, MB/GB).
function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Whole days from now until `d` (negative if past). Used for the trial
// countdown copy ("ends in 3 days").
function daysUntil(d: Date | null): number | null {
  if (!d) return null;
  return Math.ceil((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function statusLabel(status: string | null): string {
  if (!status) return "Free";
  switch (status) {
    case "active":     return "Active";
    case "trialing":   return "Trialing";
    case "past_due":   return "Past due";
    case "canceled":   return "Canceled";
    case "incomplete": return "Incomplete";
    case "unpaid":     return "Unpaid";
    default:           return status;
  }
}

const NOTICE = {
  background: "var(--surface-2)",
  border: "var(--border)",
  borderRadius: "var(--r-sm)",
  padding: "10px 12px",
  lineHeight: 1.55,
} as const;

const ERR_NOTICE = {
  background: "var(--err-bg)",
  border: "1px solid var(--err-border)",
  color: "var(--err-text)",
  borderRadius: "var(--r-sm)",
  padding: "10px 12px",
  lineHeight: 1.55,
} as const;

export default async function BillingPage({ searchParams }: {
  searchParams: { stripe?: string; plan?: string; interval?: string };
}) {
  const cloud = isCloud();
  const { workspace, user } = await getActiveSession();
  const isAdmin = user.role === "admin";

  // ── self-host: AGPL-free messaging, no subscription mechanics ────
  if (!cloud) {
    return (
      <Card>
        <CardHead title="Billing" after={<Pill ring>Self-hosted</Pill>} />
        <div className="card-body col gap-3">
          <p className="text-sm note">
            You're <strong style={{ fontWeight: 500 }}>self-hosting Crumb</strong>, free under AGPL with no subscription fee and no usage limits.
          </p>
          <p className="text-xs muted note">
            The hosted tier at <a href="https://crumb.localhostlabs.net" style={{ color: "var(--ink)" }}>crumb.localhostlabs.net</a> adds managed email delivery, hosted inbound replies, AI clustering, and one-click Slack/Linear integrations. Same source code, same OSS license. You're paying for the ops layer.
          </p>
        </div>
      </Card>
    );
  }

  // ── Cloud: real subscription view ───────────────────────────────
  const status = workspace.subscriptionStatus;
  const active = isActiveStatus(status);
  const plan = workspacePlan(workspace);
  const configured = stripeConfigured();
  const misconfigured = stripeKeyMisconfigured();
  const usage = active ? await getUsageSummary(workspace) : [];

  // Back from Stripe Checkout. Until the webhook activates the plan, keep the
  // picker hidden so a slow activation can't invite a second payment.
  const checkout = searchParams.stripe === "success" || searchParams.stripe === "cancel" ? searchParams.stripe : null;
  const showPicker = !active && checkout !== "success";
  // The visitor's pick (from signup, or a canceled checkout), preselected.
  const pickedPlan: PaidPlan | null = searchParams.plan === "team" || searchParams.plan === "growth" ? searchParams.plan : null;
  const pickedInterval: BillingInterval = searchParams.interval === "month" ? "month" : "year";

  // A subscriber is offered the plans above theirs and moves up in the Stripe
  // portal (Upgrade), never by checking out a second subscription.
  const offered = showPicker ? UPGRADES : active ? UPGRADES.slice(UPGRADES.findIndex(u => u.id === plan) + 1) : [];
  let planCards: PlanCard[] = [];
  if (offered.length > 0) {
    const prices = await planPrices();
    planCards = offered.map(({ id, over }) => ({
      id,
      name: planDisplayName(id),
      intro: `Everything in ${planDisplayName(over)}, plus:`,
      features: featureLines(id, over),
      prices: prices[id],
    }));
  }

  return (
    <Card>
      <CardHead
        title="Billing"
        after={
          <Pill ring ringFill={active}>
            {statusLabel(status)}
          </Pill>
        }
      />
      <div className="card-body col gap-4">
        {checkout && <CheckoutReturn result={checkout} activated={active} planName={planDisplayName(plan)} />}

        {status === "past_due" && (
          <div className="text-sm" style={ERR_NOTICE}>
            <strong style={{ fontWeight: 600 }}>Your last payment failed.</strong> Update your
            card to keep your {planDisplayName(plan)} features. They stay on during a short grace
            period, then this workspace moves to the Free plan.
            {isAdmin ? " Open the billing portal below to fix it." : " Ask a workspace admin to update billing."}
          </div>
        )}

        {status === "trialing" && (() => {
          const left = daysUntil(workspace.currentPeriodEnd);
          return (
            <div className="text-sm" style={NOTICE}>
              <strong style={{ fontWeight: 600 }}>You're on a free trial.</strong>{" "}
              {left != null && left >= 0 && workspace.currentPeriodEnd
                ? `It ${left === 0 ? "ends today" : `ends in ${left} day${left === 1 ? "" : "s"}`} (${formatDate(workspace.currentPeriodEnd)}).`
                : "Add a payment method to keep your plan after the trial."}{" "}
              {isAdmin ? "Manage your card in the portal below." : ""}
            </div>
          );
        })()}

        {!configured && (
          <div className="text-sm" style={ERR_NOTICE}>
            Stripe isn't configured on this deployment. Set <span className="mono">STRIPE_SECRET_KEY</span> and <span className="mono">STRIPE_WEBHOOK_SECRET</span>, and create prices with lookup keys <span className="mono">team_monthly/annual</span> and <span className="mono">growth_monthly/annual</span>.
          </div>
        )}

        {misconfigured && (
          <div className="text-sm" style={ERR_NOTICE}>
            <strong style={{ fontWeight: 600 }}>Stripe is in test mode on a live deployment.</strong> Checkouts
            will complete but <strong style={{ fontWeight: 600 }}>never actually charge</strong>, so workspaces look
            subscribed while no payment is taken. Set a live <span className="mono">STRIPE_SECRET_KEY</span> (<span className="mono">sk_live_…</span>).
          </div>
        )}

        <div className="col gap-1">
          <span className="eyebrow">Plan</span>
          <span className="serif text-md">{planDisplayName(plan)}</span>
        </div>

        <div className="col gap-2">
          <span className="eyebrow">Includes</span>
          <FeatureList items={featureLines(plan)} />
        </div>

        {workspace.currentPeriodEnd && (
          <div className="col gap-1">
            <span className="eyebrow">{status === "canceled" ? "Ended" : "Renews"}</span>
            <span className="text-md">{formatDate(workspace.currentPeriodEnd)}</span>
          </div>
        )}

        {usage.length > 0 && (
          <div className="col gap-2">
            <span className="eyebrow">This month</span>
            <div className="col gap-3">
              {usage.map(line => {
                const pct = line.cap > 0 ? Math.min(100, Math.round((line.used / line.cap) * 100)) : 0;
                const near = pct >= 80;
                const fmt = line.metric === "replay_bytes" ? formatBytes : (n: number) => n.toLocaleString("en-US");
                return (
                  <div key={line.metric} className="col gap-1">
                    <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                      <span className="text-sm">{USAGE_LABEL[line.metric]}</span>
                      <span className="text-xs muted">{fmt(line.used)} / {fmt(line.cap)}</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 999, background: "var(--surface-2)", overflow: "hidden" }}>
                      <div style={{
                        width: `${pct}%`,
                        height: "100%",
                        borderRadius: 999,
                        background: near ? "var(--err-text)" : "var(--ember)",
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {showPicker && (
          <>
            <p className="text-sm muted note">
              {isAdmin
                ? "Upgrade for the AI suite, integrations and more. Cancel any time from the billing portal."
                : "Paid plans add the AI suite, integrations and more. Ask a workspace admin to upgrade."}
            </p>
            <PlanPicker
              plans={planCards}
              initialPlan={pickedPlan}
              initialInterval={pickedInterval}
              canBuy={isAdmin && configured}
            />
          </>
        )}

        {active && planCards.length > 0 && (
          <>
            {isAdmin && (
              <p className="text-sm muted note">
                Move up a plan any time. You'll review and confirm the change in the Stripe billing portal.
              </p>
            )}
            <PlanPicker
              plans={planCards}
              initialPlan={pickedPlan}
              initialInterval={pickedInterval}
              canBuy={isAdmin && configured}
              upgrade
            />
          </>
        )}

        {active && configured && isAdmin && (
          <>
            <p className="text-sm muted note">
              Open the Stripe portal to update payment method, download invoices, or cancel your subscription.
            </p>
            <ManageButton />
          </>
        )}

        {!isAdmin && !showPicker && (
          <p className="text-xs muted" style={{ margin: 0 }}>
            Only workspace admins can manage billing.
          </p>
        )}
      </div>
    </Card>
  );
}
