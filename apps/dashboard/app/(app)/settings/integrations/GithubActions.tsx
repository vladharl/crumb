"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic } from "@crumb/ui";
import { startGithubInstall, disconnectGithub } from "./actions";

export function ConnectGithubButton({ disabled }: { disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Btn
      sm
      variant="primary"
      icon={<Ic.plug style={{ width: 12, height: 12 }} />}
      disabled={disabled || pending}
      onClick={() => startTransition(async () => {
        try { await startGithubInstall(); } catch { /* redirect or config error */ }
      })}
    >
      {pending ? "Opening GitHub…" : "Install GitHub App"}
    </Btn>
  );
}

export function DisconnectGithubButton({ account }: { account: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row gap-2 center">
      <Btn
        sm
        disabled={pending}
        onClick={() => {
          if (!confirm(`Disconnect ${account ?? "GitHub"}? Existing ticket links stay on items; status sync stops. (Also uninstall the app from GitHub if you want the App's permissions revoked.)`)) return;
          startTransition(async () => {
            setError(null);
            const r = await disconnectGithub();
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
