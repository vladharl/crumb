"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Dropdown, Ic } from "@crumb/ui";
import { useConfirm } from "@/components/confirm";
import { errorMessage } from "@/lib/action-error";
import { getCrmCardStatus, type CrmCardStatus } from "@/lib/integrations/crm/status";
import {
  startHubspotInstall,
  disconnectHubspot,
  startSalesforceInstall,
  disconnectSalesforce,
  syncCrmNow,
  listCrmArrFields,
  setCrmArrField,
} from "./actions";
import { isRedirectError, connectErrorMessage } from "./connect-shared";
import type { CrmField, CrmProvider } from "@/lib/integrations/crm/types";

const CRM_NAME: Record<CrmProvider, string> = { hubspot: "HubSpot", salesforce: "Salesforce" };

// A sync that didn't complete, in words (lib/integrations/crm/sync.ts SyncError).
function syncErrorText(code: string, name: string): string {
  switch (code) {
    case "plan_required":  return `${name} sync is paused on your current plan. Upgrade in Settings, then Billing, to turn it back on.`;
    case "partial":        return `${name} stopped responding partway, so only some accounts updated. Try Sync now again in a few minutes.`;
    case "failed":         return `Couldn't reach ${name}, so nothing updated. Try Sync now again in a few minutes.`;
    case "disconnected":   return `${name} stopped accepting Crumb's access, so it was disconnected. Reconnect it to keep syncing.`;
    case "not_configured": return `${name} isn't configured on this deployment.`;
    default:               return errorMessage(code);
  }
}

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
            else setError(errorMessage(r.error));
          });
        }}
      >
        {pending ? "Disconnecting…" : "Disconnect"}
      </Btn>
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}

// "Sync now", plus the card's sync status: "Syncing…" while a sync runs (the
// first one starts right after connecting, Sync now starts one, both in the
// background), how the last one went if it didn't complete, and a paused note
// when the plan no longer includes integrations.
export function SyncCrmButton({ provider }: { provider: CrmProvider }) {
  const router = useRouter();
  const name = CRM_NAME[provider];
  const [status, setStatus] = useState<CrmCardStatus | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Bumped by Sync now, to start polling the sync it just started.
  const [started, setStarted] = useState(0);

  // Poll while a sync runs, then refresh the card's counts once it ends.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (wasRunning: boolean) => {
      const s = await getCrmCardStatus(provider).catch(() => null);
      if (!live || !s) return;
      setStatus(s);
      if (s.running) timer = setTimeout(() => void load(true), 3000);
      else if (wasRunning) router.refresh();
    };
    void load(started > 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [provider, router, started]);

  const running = pending || !!status?.running;
  const paused = !!status?.paused;
  // The last run's problem, until this visit's own Sync now says otherwise.
  const lastProblem = !error && status?.lastError ? syncErrorText(status.lastError, name) : null;

  return (
    <>
      <div className="row gap-2 center">
        <Btn
          sm
          icon={<Ic.chevR style={{ width: 11, height: 11 }} />}
          disabled={running || paused}
          onClick={() => startTransition(async () => {
            setError(null);
            const r = await syncCrmNow(provider);
            if (r.ok) setStarted(n => n + 1);
            else setError(syncErrorText(r.error, name));
          })}
        >
          {running ? "Syncing…" : "Sync now"}
        </Btn>
        {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
      </div>
      {/* After the row's buttons (order), on a line of its own (basis 100%). */}
      {(paused || lastProblem) && (
        <div className="col gap-1 text-xs" style={{ order: 1, flexBasis: "100%", maxWidth: "62ch", lineHeight: 1.55 }}>
          {paused && <span className="muted">{syncErrorText("plan_required", name)}</span>}
          {lastProblem && <span style={{ color: "var(--err-text)" }}>{lastProblem}</span>}
        </div>
      )}
    </>
  );
}

// Admin-only: the CRM field each company's ARR syncs from. The stock
// annual-revenue field is the company's own revenue, so nothing is assumed: a
// new connection syncs names until one is chosen here (self-host can preset
// HubSpot's with HUBSPOT_ARR_PROPERTY). Lists the CRM's number and currency
// fields on open; choosing one saves it and starts a sync.
export function CrmArrFieldPicker({ provider, current }: { provider: CrmProvider; current: string | null }) {
  const router = useRouter();
  const name = CRM_NAME[provider];
  const [fields, setFields] = useState<CrmField[] | null>(null); // null: picker closed
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function load() {
    setError(null);
    startTransition(async () => {
      const r = await listCrmArrFields(provider);
      if (r.ok && r.fields.length) setFields(r.fields);
      else if (r.ok) setError(`${name} has no number or currency fields yet. Add one that holds ARR, then try again.`);
      else if (r.error === "revoked") router.refresh(); // disconnected; the card says so
      else setError(r.error === "list_failed" ? `Couldn't load fields from ${name}. Try again in a few minutes.` : errorMessage(r.error));
    });
  }

  function choose(field: string) {
    if (field === current) { setFields(null); return; }
    startTransition(async () => {
      const r = await setCrmArrField(provider, field);
      setFields(null);
      if (r.ok) router.refresh();
      else setError(r.error === "invalid_field" ? "That field can't be used for ARR." : errorMessage(r.error));
    });
  }

  if (fields) {
    return (
      <div style={{ minWidth: 240, maxWidth: 360 }}>
        <Dropdown
          ariaLabel={`${name} field that holds ARR`}
          value={current ?? ""}
          placeholder="Field that holds ARR"
          onChange={choose}
          disabled={pending}
          searchable={fields.length > 8}
          buttonStyle={{ width: "100%" }}
          options={fields.map(f => ({ value: f.name, label: f.label === f.name ? f.name : `${f.label} (${f.name})` }))}
        />
      </div>
    );
  }
  return (
    <div className="row gap-2 center">
      <Btn sm onClick={load} disabled={pending}>
        {pending ? "Loading fields…" : current ? "Change ARR field" : "Choose ARR field"}
      </Btn>
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
