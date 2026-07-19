import { Card, CardHead, Pill } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { isCloud } from "@/lib/tier";
import { stripeConfigured, stripeKeyMisconfigured, isActiveStatus } from "@/lib/stripe";
import { workspaceFeatures, PLAN_FEATURE_MAP, type Feature } from "@/lib/entitlements";
import { getUsageSummary, type UsageMetric } from "@/lib/usage";
import { PlanPicker, ManageButton, type PlanCard } from "./BillingActions";

const FEATURE_LABEL: Record<Feature, string> = {
  ai: "AI clustering + ticket drafts",
  session_record: "Session Record (replay)",
  integrations: "Linear / Jira / GitHub / Slack",
  usage_analytics: "Product usage analytics",
};

const USAGE_LABEL: Record<UsageMetric, string> = {
  ai: "AI operations",
  replay_bytes: "Session replay",
  usage_events: "Usage events",
};

export const dynamic = "force-dynamic";

// Human-readable bytes for the replay-storage meter (1024-based, MB/GB).
function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function formatDate(d: Date | null): string {
  if (!d) return "—";
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

export default async function BillingPage() {
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
            You're <strong style={{ fontWeight: 500 }}>self-hosting Crumb</strong> — free under AGPL, with no subscription fee and no usage limits.
          </p>
          <p className="text-xs muted note">
            The hosted tier at <a href="https://crumb.localhostlabs.net" style={{ color: "var(--ink)" }}>crumb.localhostlabs.net</a> adds managed email delivery, hosted inbound replies, AI clustering, and one-click Slack/Linear integrations. Same source code, same OSS license — you're paying for the ops layer.
          </p>
        </div>
      </Card>
    );
  }

  // ── Cloud: real subscription view ───────────────────────────────
  const status = workspace.subscriptionStatus;
  const active = isActiveStatus(status);
  const configured = stripeConfigured();
  const misconfigured = stripeKeyMisconfigured();
  const usage = active ? await getUsageSummary(workspace) : [];

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
        {status === "past_due" && (
          <div className="text-sm" style={{
            background: "var(--err-bg)",
            border: "1px solid var(--err-border)",
            color: "var(--err-text)",
            borderRadius: "var(--r-sm)",
            padding: "10px 12px",
            lineHeight: 1.55,
          }}>
            <strong style={{ fontWeight: 600 }}>Your last payment failed.</strong> Update your
            card to keep AI, integrations, and managed email — paid features stay live during a
            short grace period, then this workspace drops to the free plan.
            {isAdmin ? " Open the billing portal below to fix it." : " Ask a workspace admin to update billing."}
          </div>
        )}

        {status === "trialing" && (() => {
          const left = daysUntil(workspace.currentPeriodEnd);
          return (
            <div className="text-sm" style={{
              background: "var(--bone-2)",
              border: "var(--border)",
              borderRadius: "var(--r-sm)",
              padding: "10px 12px",
              lineHeight: 1.55,
            }}>
              <strong style={{ fontWeight: 600 }}>You're on a free trial.</strong>{" "}
              {left != null && left >= 0
                ? `It ${left === 0 ? "ends today" : `ends in ${left} day${left === 1 ? "" : "s"}`} (${formatDate(workspace.currentPeriodEnd)}).`
                : "Add a payment method to keep your plan after the trial."}{" "}
              {isAdmin ? "Manage your card in the portal below." : ""}
            </div>
          );
        })()}

        {!configured && (
          <div className="text-sm" style={{
            background: "var(--err-bg)",
            border: "1px solid var(--err-border)",
            color: "var(--err-text)",
            borderRadius: "var(--r-sm)",
            padding: "10px 12px",
            lineHeight: 1.55,
          }}>
            Stripe isn't configured on this deployment. Set <span className="mono">STRIPE_SECRET_KEY</span> and <span className="mono">STRIPE_WEBHOOK_SECRET</span>, and create prices with lookup keys <span className="mono">team_monthly/annual</span> and <span className="mono">growth_monthly/annual</span>.
          </div>
        )}

        {misconfigured && (
          <div className="text-sm" style={{
            background: "var(--err-bg)",
            border: "1px solid var(--err-border)",
            color: "var(--err-text)",
            borderRadius: "var(--r-sm)",
            padding: "10px 12px",
            lineHeight: 1.55,
          }}>
            <strong style={{ fontWeight: 600 }}>Stripe is in test mode on a live deployment.</strong> Checkouts
            will complete but <strong style={{ fontWeight: 600 }}>never actually charge</strong> — workspaces look
            subscribed while no payment is taken. Set a live <span className="mono">STRIPE_SECRET_KEY</span> (<span className="mono">sk_live_…</span>).
          </div>
        )}

        <div className="col gap-1">
          <span className="eyebrow">Plan</span>
          <span className="serif text-md">{workspace.planId}</span>
        </div>

        <div className="col gap-2">
          <span className="eyebrow">Includes</span>
          {(() => {
            const features = workspaceFeatures(workspace);
            if (features.length === 0) {
              return <span className="text-sm muted">Core feedback flow only — upgrade to unlock add-ons.</span>;
            }
            return (
              <div className="row gap-2" style={{ flexWrap: "wrap" }}>
                {features.map(f => <Pill key={f} ring ringFill>{FEATURE_LABEL[f]}</Pill>)}
              </div>
            );
          })()}
        </div>

        <div className="col gap-1">
          <span className="eyebrow">{status === "canceled" ? "Ended" : "Renews"}</span>
          <span className="text-md">{formatDate(workspace.currentPeriodEnd)}</span>
        </div>

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
                    <div style={{ height: 4, borderRadius: 999, background: "var(--bone-2)", overflow: "hidden" }}>
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

        {!active && configured && isAdmin && (() => {
          const planCards: PlanCard[] = (["team", "growth"] as const).map(id => ({
            id,
            name: id.charAt(0).toUpperCase() + id.slice(1),
            features: PLAN_FEATURE_MAP[id].map(f => FEATURE_LABEL[f]),
          }));
          return (
            <>
              <p className="text-sm muted note">
                Pick a plan to unlock managed email, AI clustering, and integrations. Annual is billed once a year; cancel any time from the portal.
              </p>
              <PlanPicker plans={planCards} />
            </>
          );
        })()}

        {active && configured && isAdmin && (
          <>
            <p className="text-sm muted note">
              Open the Stripe portal to update payment method, download invoices, or cancel your subscription.
            </p>
            <ManageButton />
          </>
        )}

        {!isAdmin && (
          <p className="text-xs muted" style={{ margin: 0 }}>
            Only workspace admins can manage billing.
          </p>
        )}
      </div>
    </Card>
  );
}
