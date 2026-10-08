"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic } from "@crumb/ui";
import type { BillingInterval, PaidPlan, PlanPrice } from "@/lib/stripe";
import { createCheckoutSession, createPortalSession } from "./actions";

export type FeatureLine = { label: string; limit?: string };

export type PlanCard = {
  id: PaidPlan;
  name: string;
  intro: string;
  features: FeatureLine[];
  prices: Record<BillingInterval, PlanPrice>;
};

// ponytail: two-decimal currencies only (Stripe amounts in cents). Add a
// zero-decimal table if a JPY/KRW price ever ships.
function money(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);
}

// How much a year of annual billing saves over twelve monthly payments, in
// minor units. 0 when there's no saving or the currencies differ.
function annualSaving({ month, year }: Record<BillingInterval, PlanPrice>): number {
  return month.currency === year.currency ? Math.max(0, month.amount * 12 - year.amount) : 0;
}

export function FeatureList({ items }: { items: FeatureLine[] }) {
  return (
    <ul className="col gap-2" style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {items.map(f => (
        <li key={f.label} className="row gap-2 text-sm" style={{ alignItems: "flex-start" }}>
          <Ic.check aria-hidden style={{ width: 12, height: 12, flex: "none", marginTop: 2 }} />
          <span className="col">
            <span>{f.label}</span>
            {f.limit && <span className="text-xs muted">{f.limit}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

// Plan + interval picker. Without an active subscription it checks out; with
// one (`upgrade`) it lists the plans above the current one and each opens the
// Stripe portal's plan change for the existing subscription, so a subscriber
// never starts a second one. The interval toggle drives which Stripe price
// each card shows and checks out; `initialPlan` / `initialInterval` carry the
// visitor's pick from the URL (signup, a canceled checkout, an upgrade notice)
// so it isn't lost.
export function PlanPicker({ plans, initialPlan, initialInterval, canBuy, upgrade = false }: {
  plans: PlanCard[];
  initialPlan: PaidPlan | null;
  initialInterval: BillingInterval;
  canBuy: boolean;
  upgrade?: boolean;
}) {
  const [interval, pickInterval] = useState<BillingInterval>(initialInterval);
  const [busyPlan, setBusyPlan] = useState<PaidPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Quote the smallest saving across plans so the toggle never overstates it.
  const savePct = Math.min(...plans.map(p => Math.floor((annualSaving(p.prices) / (p.prices.month.amount * 12)) * 100)));

  function choose(plan: PaidPlan) {
    setError(null);
    setBusyPlan(plan);
    startTransition(async () => {
      const r = upgrade ? await createPortalSession(true) : await createCheckoutSession(plan, interval);
      if (r.ok) { window.location.href = r.url; return; }
      setError(r.error);
      setBusyPlan(null);
    });
  }

  return (
    <div className="col gap-3">
      <div className="row gap-3" style={{ flexWrap: "wrap" }}>
        <div className="seg" role="group" aria-label="Billing interval">
          {(["month", "year"] as const).map(i => (
            <button
              key={i}
              type="button"
              aria-pressed={interval === i}
              disabled={pending}
              onClick={() => pickInterval(i)}
            >
              {i === "month" ? "Monthly" : "Annual"}
            </button>
          ))}
        </div>
        {savePct > 0 && <span className="text-xs muted">Save {savePct}% with annual billing</span>}
      </div>

      <div className="row gap-3" style={{ flexWrap: "wrap", alignItems: "stretch" }}>
        {plans.map(p => {
          const price = p.prices[interval];
          const saving = annualSaving(p.prices);
          const picked = p.id === initialPlan;
          return (
            <div
              key={p.id}
              className="card col gap-3"
              style={{ padding: 16, minWidth: 220, flex: "1 1 220px", borderColor: picked ? "var(--accent)" : undefined }}
            >
              <div className="col gap-1">
                <span className="serif text-md">{p.name}</span>
                <span className="row gap-1" style={{ alignItems: "baseline" }}>
                  <span className="serif text-2xl tabular">
                    {money(interval === "year" ? Math.round(price.amount / 12) : price.amount, price.currency)}
                  </span>
                  <span className="text-sm muted">/mo</span>
                </span>
                <span className="text-xs muted">
                  {interval === "year"
                    ? `Billed ${money(price.amount, price.currency)} a year${saving > 0 ? `, saving ${money(saving, price.currency)}` : ""}.`
                    : "Billed monthly."}
                </span>
              </div>
              <span className="text-xs muted">{p.intro}</span>
              <FeatureList items={p.features} />
              {canBuy && (
                <Btn
                  variant={picked || !initialPlan ? "primary" : undefined}
                  full
                  disabled={pending}
                  onClick={() => choose(p.id)}
                  style={{ marginTop: "auto" }}
                >
                  {busyPlan === p.id
                    ? (upgrade ? "Opening portal…" : "Opening checkout…")
                    : `${upgrade ? "Upgrade to" : "Choose"} ${p.name}`}
                </Btn>
              )}
            </div>
          );
        })}
      </div>

      {error && <span className="text-xs" role="alert" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}

// Shown when Stripe Checkout sends the visitor back. After a payment the
// webhook usually lands within seconds, so refresh the server view until the
// plan flips, and stop after a minute with a calm note: the payment went
// through, it's only the activation that's slow.
export function CheckoutReturn({ result, activated, planName }: {
  result: "success" | "cancel";
  activated: boolean;
  planName: string;
}) {
  const router = useRouter();
  const [slow, setSlow] = useState(false);
  const waiting = result === "success" && !activated;

  useEffect(() => {
    if (!waiting) return;
    const tick = setInterval(() => router.refresh(), 3_000);
    const stop = setTimeout(() => { clearInterval(tick); setSlow(true); }, 60_000);
    return () => { clearInterval(tick); clearTimeout(stop); };
  }, [waiting, router]);

  const text = result === "cancel"
    ? "Checkout canceled. You weren't charged."
    : activated
      ? `Payment received. You're on the ${planName} plan now. Thanks for upgrading.`
      : slow
        ? "Payment received. Your plan is taking longer than usual to switch on, so check back in a few minutes. There's no need to pay again."
        : "Payment received. Activating your plan…";

  return (
    <div role="status" className="text-sm" style={{
      background: "var(--surface-2)",
      border: "var(--border)",
      borderRadius: "var(--r-sm)",
      padding: "10px 12px",
      lineHeight: 1.55,
    }}>
      {text}
    </div>
  );
}

export function ManageButton({ disabled }: { disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="col gap-2" style={{ alignItems: "flex-start" }}>
      <Btn
        disabled={disabled || pending}
        onClick={() => startTransition(async () => {
          setError(null);
          const r = await createPortalSession();
          if (r.ok) window.location.href = r.url;
          else setError(r.error);
        })}
      >
        {pending ? "Opening portal…" : "Manage subscription"}
      </Btn>
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}
