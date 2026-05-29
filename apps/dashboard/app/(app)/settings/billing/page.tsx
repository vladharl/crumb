import { Card, CardHead, Pill } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { isCloud } from "@/lib/tier";
import { stripeConfigured, isActiveStatus } from "@/lib/stripe";
import { UpgradeButton, ManageButton } from "./BillingActions";

export const dynamic = "force-dynamic";

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
            The hosted tier at <a href="https://usecrumb.xyz" style={{ color: "var(--ink)" }}>usecrumb.xyz</a> adds managed email delivery, hosted inbound replies, AI clustering, and one-click Slack/Linear integrations. Same source code, same OSS license — you're paying for the ops layer.
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
