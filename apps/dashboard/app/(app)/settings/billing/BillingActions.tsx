"use client";

import { useState, useTransition } from "react";
import { Btn, Ic } from "@crumb/ui";
import { createCheckoutSession, createPortalSession } from "./actions";

export function UpgradeButton({ disabled }: { disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="col gap-2" style={{ alignItems: "flex-start" }}>
      <Btn
        variant="primary"
        icon={<Ic.send style={{ width: 12, height: 12 }} />}
        disabled={disabled || pending}
        onClick={() => startTransition(async () => {
          setError(null);
          const r = await createCheckoutSession();
          if (r.ok) window.location.href = r.url;
          else setError(r.error);
        })}
      >
        {pending ? "Opening checkout…" : "Upgrade to Cloud"}
      </Btn>
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
