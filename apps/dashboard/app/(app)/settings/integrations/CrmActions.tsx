"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic } from "@crumb/ui";
import { useConfirm } from "@/components/confirm";
import {
  startHubspotInstall,
  disconnectHubspot,
  startSalesforceInstall,
  disconnectSalesforce,
  syncCrmNow,
} from "./actions";
import { isRedirectError, connectErrorMessage } from "./connect-shared";
import type { CrmProvider } from "@/lib/integrations/crm/types";

function ConnectButton({
  label, opening, start,
}: {
  label: string;
  opening: string;
  start: () => Promise<{ ok: false; error: string } | void>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="col gap-1">
      <Btn
        sm
        variant="primary"
        icon={<Ic.plug style={{ width: 12, height: 12 }} />}
        disabled={pending}
        onClick={() => startTransition(async () => {
          setError(null);
          try {
            const r = await start();
            if (r) setError(connectErrorMessage(r.error));
          } catch (e) {
            if (isRedirectError(e)) throw e;
            setError("Couldn't start the connection. Please try again.");
          }
        })}
      >
        {pending ? opening : label}
      </Btn>
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}

function DisconnectButton({
  title, body, disconnect,
}: {
  title: string;
  body: string;
  disconnect: () => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row gap-2 center">
      <Btn
        sm
        disabled={pending}
        onClick={async () => {
          if (!(await confirm({ title, body, confirmLabel: "Disconnect", destructive: true }))) return;
          startTransition(async () => {
            setError(null);
            const r = await disconnect();
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

// "Sync now" — pulls accounts + ARR on demand. Shows the upserted count.
export function SyncCrmButton({ provider }: { provider: CrmProvider }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row gap-2 center">
      <Btn
        sm
        icon={<Ic.chevR style={{ width: 11, height: 11 }} />}
        disabled={pending}
        onClick={() => startTransition(async () => {
          setError(null);
          setMsg(null);
          const r = await syncCrmNow(provider);
          if (r.ok) {
            setMsg(`Synced ${r.upserted} ${r.upserted === 1 ? "account" : "accounts"}.`);
            router.refresh();
          } else {
            setError(r.error === "fetch_failed" ? "Couldn't reach the CRM — check the connection." : r.error);
          }
        })}
      >
        {pending ? "Syncing…" : "Sync now"}
      </Btn>
      {msg && <span className="text-xs muted">{msg}</span>}
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}

export function ConnectHubspotButton() {
  return <ConnectButton label="Connect HubSpot" opening="Opening HubSpot…" start={startHubspotInstall} />;
}
export function DisconnectHubspotButton() {
  return (
    <DisconnectButton
      title="Disconnect HubSpot?"
      body="Synced accounts keep their current ARR, but it will stop refreshing from HubSpot."
      disconnect={disconnectHubspot}
    />
  );
}
export function ConnectSalesforceButton() {
  return <ConnectButton label="Connect Salesforce" opening="Opening Salesforce…" start={startSalesforceInstall} />;
}
export function DisconnectSalesforceButton() {
  return (
    <DisconnectButton
      title="Disconnect Salesforce?"
      body="Synced accounts keep their current ARR, but it will stop refreshing from Salesforce."
      disconnect={disconnectSalesforce}
    />
  );
}
