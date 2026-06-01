import { Card, CardHead, Pill } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { isCloud } from "@/lib/tier";
import { stripeConfigured, isActiveStatus } from "@/lib/stripe";
import { workspaceFeatures, type Feature } from "@/lib/entitlements";
import { UpgradeButton, ManageButton } from "./BillingActions";

const FEATURE_LABEL: Record<Feature, string> = {
  ai: "AI clustering + ticket drafts",
  session_record: "Session Record (replay)",
  integrations: "Linear / Jira / GitHub / Slack",
  usage_analytics: "Product usage analytics",
};

export const dynamic = "force-dynamic";

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
          <p className="text-sm" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
            You're <strong style={{ fontWeight: 500 }}>self-hosting Crumb</strong> — free under AGPL, with no per-seat fee and no usage limits.
          </p>
          <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
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
            Stripe isn't configured on this deployment. Set <span className="mono">STRIPE_SECRET_KEY</span>, <span className="mono">STRIPE_PRICE_ID</span>, and <span className="mono">STRIPE_WEBHOOK_SECRET</span>.
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

        <div className="row gap-6" style={{ flexWrap: "wrap" }}>
          <div className="col gap-1">
            <span className="eyebrow">Seats</span>
            <span className="text-md">{workspace.seats}</span>
          </div>
          <div className="col gap-1">
            <span className="eyebrow">{status === "canceled" ? "Ended" : "Renews"}</span>
            <span className="text-md">{formatDate(workspace.currentPeriodEnd)}</span>
          </div>
        </div>

        {!active && configured && isAdmin && (
          <>
            <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
              Upgrade to unlock managed email, AI clustering, and Slack — billed monthly, per seat. Cancel any time from the portal.
            </p>
            <UpgradeButton />
          </>
        )}

        {active && configured && isAdmin && (
          <>
            <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
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
