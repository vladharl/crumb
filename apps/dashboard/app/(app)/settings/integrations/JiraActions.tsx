"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic } from "@crumb/ui";
import { startJiraInstall, disconnectJira } from "./actions";

export function ConnectJiraButton({ disabled }: { disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Btn
      sm
      variant="primary"
      icon={<Ic.plug style={{ width: 12, height: 12 }} />}
      disabled={disabled || pending}
      onClick={() => startTransition(async () => {
        try { await startJiraInstall(); } catch { /* redirect or config error */ }
      })}
    >
      {pending ? "Opening Jira…" : "Connect Jira"}
    </Btn>
  );
}

export function DisconnectJiraButton({ siteUrl }: { siteUrl: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const site = siteUrl ? siteUrl.replace(/^https?:\/\//, "") : "Jira";
  return (
    <div className="row gap-2 center">
      <Btn
        sm
        disabled={pending}
        onClick={() => {
          if (!confirm(`Disconnect ${site}? Existing ticket links stay on items; status sync stops.`)) return;
          startTransition(async () => {
            setError(null);
            const r = await disconnectJira();
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
