"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic } from "@crumb/ui";
import { startLinearInstall, disconnectLinear } from "./actions";

export function ConnectLinearButton({ disabled }: { disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Btn
      sm
      variant="primary"
      icon={<Ic.plug style={{ width: 12, height: 12 }} />}
      disabled={disabled || pending}
      onClick={() => startTransition(async () => {
        try {
          await startLinearInstall();
        } catch {
          // Server action redirected (expected) or threw a config error.
        }
      })}
    >
      {pending ? "Opening Linear…" : "Connect Linear"}
    </Btn>
  );
}

export function DisconnectLinearButton({ teamName }: { teamName: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row gap-2 center">
      <Btn
        sm
        disabled={pending}
        onClick={() => {
          if (!confirm(`Disconnect Linear (${teamName ?? "team"})? Existing ticket links stay on items, but status sync will stop.`)) return;
          startTransition(async () => {
            setError(null);
            const r = await disconnectLinear();
            if (r.ok) router.refresh();
            else setError(r.error);
          });
        }}
      >
        {pending ? "Disconnecting…" : "Disconnect"}
      </Btn>
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}
