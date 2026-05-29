"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic } from "@crumb/ui";
import { startSlackInstall, disconnectSlack } from "./actions";

export function ConnectSlackButton({ disabled }: { disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Btn
      sm
      variant="primary"
      icon={<Ic.plug style={{ width: 12, height: 12 }} />}
      disabled={disabled || pending}
      onClick={() => startTransition(async () => {
        // Server action will throw a NEXT_REDIRECT — that's expected.
        // Errors propagating past that mean misconfig; surface generic
        // failure (the user sees the integrations page render with no
        // change, which is the same result as a real OAuth abort).
        try {
          await startSlackInstall();
        } catch {
          // no-op: redirect or known failure
        }
      })}
    >
      {pending ? "Opening Slack…" : "Connect Slack"}
    </Btn>
  );
}

export function DisconnectSlackButton({ teamName }: { teamName: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row gap-2 center">
      <Btn
        sm
        disabled={pending}
        onClick={() => {
          if (!confirm(`Disconnect Crumb from ${teamName ?? "Slack"}? Vendor notifications will revert to email.`)) return;
          startTransition(async () => {
            setError(null);
            const r = await disconnectSlack();
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
