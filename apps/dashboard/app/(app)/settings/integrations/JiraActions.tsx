"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Dropdown, Ic } from "@crumb/ui";
import { useConfirm } from "@/components/confirm";
import { errorMessage } from "@/lib/action-error";
import { startJiraInstall, disconnectJira, listJiraSites, setJiraSite } from "./actions";
import { isRedirectError, connectErrorMessage } from "./connect-shared";

// `reconnect` runs the same consent again on a connected card, which is how
// status sync gets another try.
export function ConnectJiraButton({ disabled, reconnect }: { disabled?: boolean; reconnect?: boolean }) {
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
        {pending ? "Opening Jira…" : reconnect ? "Reconnect Jira" : "Connect Jira"}
      </Btn>
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}
    </div>
  );
}

function siteError(code: string): string {
  switch (code) {
    case "list_failed":    return "Couldn't load your Jira sites from Atlassian. Reload the page to try again.";
    case "site_not_found": return "Your Atlassian login no longer reaches that site. Choose another.";
    case "not_connected":  return "Jira isn't connected anymore. Connect it again.";
    default:               return errorMessage(code);
  }
}

// Admin-only, when the Atlassian login reaches several Jira sites: the one
// this workspace uses. Choosing it finishes connecting.
export function JiraSitePicker() {
  const router = useRouter();
  const [sites, setSites] = useState<Array<{ id: string; name: string; url: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    listJiraSites().then(
      r => {
        if (!live) return;
        if (!r.ok && r.error === "revoked") router.refresh(); // disconnected; the card says so
        else if (!r.ok) setError(siteError(r.error));
        else if (r.sites.length) setSites(r.sites);
        else setError("Your Atlassian login doesn't reach any Jira site now. Disconnect, then connect with an account that does.");
      },
      () => { if (live) setError(siteError("list_failed")); },
    );
    return () => { live = false; };
  }, [router]);

  function choose(id: string) {
    setError(null);
    startTransition(async () => {
      const r = await setJiraSite(id).catch(() => ({ ok: false as const, error: "failed" }));
      if (r.ok) router.refresh();
      else if (r.error === "revoked") router.refresh();
      else setError(siteError(r.error));
    });
  }

  return (
    <div className="col gap-1" style={{ maxWidth: 360 }}>
      {!sites && !error && <span className="text-sm muted">Loading your Jira sites…</span>}
      {sites && (
        <Dropdown
          ariaLabel="Jira site"
          value={null}
          placeholder={pending ? "Connecting…" : "Choose a site"}
          onChange={choose}
          disabled={pending}
          searchable={sites.length > 8}
          buttonStyle={{ width: "100%" }}
          options={sites.map(s => ({ value: s.id, label: `${s.name} (${s.url.replace(/^https?:\/\//, "")})` }))}
        />
      )}
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
