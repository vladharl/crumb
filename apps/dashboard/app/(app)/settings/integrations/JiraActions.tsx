"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic } from "@crumb/ui";
import { useConfirm } from "@/components/confirm";
import { startJiraInstall, disconnectJira } from "./actions";
import { isRedirectError, connectErrorMessage } from "./connect-shared";

export function ConnectJiraButton({ disabled }: { disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="col gap-1">
      <Btn
        sm
        variant="primary"
        icon={<Ic.plug style={{ width: 12, height: 12 }} />}
        disabled={disabled || pending}
        onClick={() => startTransition(async () => {
          setError(null);
          try {
            const r = await startJiraInstall();
            if (r) setError(connectErrorMessage(r.error));
          } catch (e) {
            if (isRedirectError(e)) throw e;
            setError("Couldn't start the connection. Please try again.");
          }
        })}
      >
        {pending ? "Opening Jira…" : "Connect Jira"}
      </Btn>
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}

export function DisconnectJiraButton({ siteUrl }: { siteUrl: string | null }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const site = siteUrl ? siteUrl.replace(/^https?:\/\//, "") : "Jira";
  return (
    <div className="row gap-2 center">
      <Btn
        sm
        disabled={pending}
        onClick={async () => {
          if (!(await confirm({
            title: `Disconnect ${site}?`,
            body: "Existing ticket links stay on items; status sync stops.",
            confirmLabel: "Disconnect",
            destructive: true,
          }))) return;
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
