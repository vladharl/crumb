"use client";

import { useState, useTransition } from "react";
import { Btn, Ic } from "@crumb/ui";
import { createCheckoutSession, createPortalSession } from "./actions";

export type PlanCard = {
  id: "team" | "growth";
  name: string;
  features: string[];
};

// Plan + interval picker shown to workspaces without an active subscription.
// A monthly/annual toggle drives which Stripe price the checkout resolves; each
// plan card kicks off Checkout for that (plan, interval).
export function PlanPicker({ plans }: { plans: PlanCard[] }) {
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function choose(plan: "team" | "growth") {
    setError(null);
    setBusyPlan(plan);
    startTransition(async () => {
      const r = await createCheckoutSession(plan, interval);
      if (r.ok) { window.location.href = r.url; return; }
      setError(r.error);
      setBusyPlan(null);
    });
  }

  return (
    <div className="col gap-3">
      <div className="row gap-1" role="group" aria-label="Billing interval">
        <Btn variant={interval === "month" ? "primary" : undefined} onClick={() => setInterval("month")} disabled={pending}>
          Monthly
        </Btn>
        <Btn variant={interval === "year" ? "primary" : undefined} onClick={() => setInterval("year")} disabled={pending}>
          Annual
        </Btn>
      </div>

      <div className="row gap-3" style={{ flexWrap: "wrap", alignItems: "stretch" }}>
        {plans.map(p => (
          <div key={p.id} className="card col gap-3" style={{ padding: 16, minWidth: 220, flex: "1 1 220px" }}>
            <span className="serif text-md">{p.name}</span>
            <ul className="col gap-1" style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {p.features.map(f => (
                <li key={f} className="row gap-2 text-sm" style={{ alignItems: "center" }}>
                  <Ic.check style={{ width: 12, height: 12 }} />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Btn
              variant="primary"
              full
              icon={<Ic.send style={{ width: 12, height: 12 }} />}
              disabled={pending}
              onClick={() => choose(p.id)}
            >
              {busyPlan === p.id ? "Opening checkout…" : `Choose ${p.name}`}
            </Btn>
          </div>
        ))}
      </div>

      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
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
