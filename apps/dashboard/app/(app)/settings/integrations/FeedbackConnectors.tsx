"use client";

import { useState, useTransition } from "react";
import { Card, CardHead, Dropdown, Pill } from "@crumb/ui";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm";
import { errorMessage } from "@/lib/action-error";
import { gmailTime } from "@/lib/timefmt";
import {
  connectFeedbackSource, disconnectFeedbackSource, estimateFeedbackBacklog, syncFeedbackNow,
} from "./FeedbackConnectorsActions";
import type { ConnectionView } from "@/lib/integrations/feedback/connections";
import type { FeedbackProvider } from "@/lib/integrations/feedback/types";

type Field = { key: string; label: string; secret?: boolean; placeholder?: string; configKey?: keyof ConnectionView["config"] };
type ProviderDef = {
  id: FeedbackProvider;
  name: string;
  blurb: string;
  fields: Field[];
  credential: string; // what "rejected the …" names
  noun: string; // what a record is, for the connect-time estimate
  hostHint?: string; // how to fix a host Crumb refuses to call
};

// What each connector pulls + the creds it needs. Non-secret fields prefill from
// the saved config; secrets are write-only (blank, re-entered to update).
const PROVIDERS: ProviderDef[] = [
  {
    id: "zendesk",
    name: "Zendesk",
    blurb: "Pull support tickets; keep real product feedback, drop the how-tos.",
    fields: [
      { key: "subdomain", label: "Subdomain", placeholder: "acme", configKey: "subdomain" },
      { key: "email", label: "Agent email", placeholder: "you@acme.com", configKey: "email" },
      { key: "apiToken", label: "API token", secret: true },
    ],
    credential: "API token",
    noun: "tickets",
    hostHint: 'Enter just the "acme" of acme.zendesk.com.',
  },
  {
    id: "freshdesk",
    name: "Freshdesk",
    blurb: "Pull tickets updated since the last sync.",
    fields: [
      { key: "domain", label: "Domain", placeholder: "acme", configKey: "domain" },
      { key: "apiKey", label: "API key", secret: true },
    ],
    credential: "API key",
    noun: "tickets",
    hostHint: 'Enter just the "acme" of acme.freshdesk.com.',
  },
  {
    id: "intercom",
    name: "Intercom",
    blurb: "Pull conversations; turn the product feedback in them into requests.",
    fields: [{ key: "accessToken", label: "Access token", secret: true }],
    credential: "access token",
    noun: "conversations",
  },
  {
    id: "freshchat",
    name: "Freshchat",
    blurb: "Pull chat conversations; turn the product feedback in them into requests.",
    fields: [
      { key: "baseUrl", label: "API base URL", placeholder: "https://acme.freshchat.com/v2", configKey: "baseUrl" },
      { key: "apiToken", label: "API token", secret: true },
    ],
    credential: "API token",
    noun: "conversations",
    hostHint: "Use your Freshchat API URL, like https://acme.freshchat.com/v2.",
  },
  {
    id: "gong",
    name: "Gong",
    blurb: "Pull call transcripts; fan each one out into the requests it contains.",
    fields: [
      { key: "accessKey", label: "Access key", secret: true },
      { key: "accessKeySecret", label: "Access key secret", secret: true },
      { key: "baseUrl", label: "Base URL (optional)", placeholder: "https://api.gong.io" },
    ],
    credential: "access key",
    noun: "calls",
    hostHint: "Use a Gong API URL like https://us-12345.api.gong.io, or leave it blank.",
  },
];

const LOOKBACK_OPTIONS = [
  { value: "0", label: "From now on" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

// The connector error codes (actions + the stored sync failure) in words.
// `connecting`: nothing is saved yet, so the fix is to try again, not reconnect.
function connectorError(code: string | null | undefined, def: ProviderDef, connecting = false): string {
  switch (code) {
    case "auth":           return `${def.name} rejected the ${def.credential}. ${connecting ? "Check it and try again." : "Reconnect it."}`;
    case "config":         return `${def.name} didn't accept the connection details. Check them and ${connecting ? "try again" : "reconnect"}.`;
    case "transient":      return "The last sync didn't finish. Crumb will retry automatically.";
    case "sync_running":   return "A sync is already running. Check back in a few minutes.";
    case "missing_fields": return "Fill in every field.";
    case "invalid_host":   return def.hostHint ?? errorMessage(code);
    case "not_connected":  return `${def.name} isn't connected.`;
    case "not_entitled":   return "Your plan doesn't include feedback connectors.";
    default:               return errorMessage(code);
  }
}

// The connection's stored state as a note, or null when it's healthy.
function stateNote(conn: ConnectionView, def: ProviderDef): string | null {
  const code = conn.lastError;
  if (!code) return null;
  if (code === "transient" && conn.status === "error") {
    return "Syncing has failed several times in a row. Crumb keeps retrying every few hours, or use Sync now.";
  }
  if (code === "auth" || code === "config" || code === "transient") return connectorError(code, def);
  return "The last sync failed. Try Sync now, or reconnect.";
}

export function FeedbackConnectors({
  connections,
  canManage,
  aiEnabled,
  paused = false,
}: {
  connections: ConnectionView[];
  canManage: boolean;
  aiEnabled: boolean;
  // The plan no longer includes connectors: nothing syncs, only disconnect works.
  paused?: boolean;
}) {
  const byProvider = new Map(connections.map((c) => [c.provider, c]));
  const shown = paused ? PROVIDERS.filter((p) => byProvider.has(p.id)) : PROVIDERS;
  return (
    <Card>
      <CardHead
        title="Feedback sources (Autopilot)"
        after={<Pill>{paused ? "Paused" : connections.length ? `${connections.length} connected` : "None connected"}</Pill>}
      />
      <div className="col gap-3" style={{ padding: "0 4px 4px" }}>
        <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "64ch" }}>
          {paused
            ? `Paused: your plan no longer includes feedback connectors, so nothing syncs. ${canManage ? "You" : "A workspace admin"} can still disconnect them.`
            : <>Pull feedback from where customers already talk. {aiEnabled
                ? "New, relevant requests are added automatically; near-duplicates fold into the existing request; anything unclear waits in the Inbox. Autopilot has its own monthly AI allowance, separate from Ask and triage."
                : "Every pulled record lands in the Inbox for you to review. On Crumb Cloud, AI adds the new, relevant ones for you."}
                {!canManage && " Only workspace admins can connect or change them."}</>}
        </p>
        {shown.map((p) => (
          <ConnectorRow key={p.id} def={p} conn={byProvider.get(p.id)} canManage={canManage} aiEnabled={aiEnabled} paused={paused} />
        ))}
      </div>
    </Card>
  );
}

function ConnectorRow({
  def, conn, canManage, aiEnabled, paused,
}: { def: ProviderDef; conn?: ConnectionView; canManage: boolean; aiEnabled: boolean; paused: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of def.fields) if (f.configKey) init[f.key] = (conn?.config?.[f.configKey] as string) ?? "";
    return init;
  });
  const [days, setDays] = useState("7");
  const [pending, start] = useTransition();
  const connected = !!conn;
  const note = conn ? stateNote(conn, def) : null;
  const canEdit = canManage && !paused;

  const connect = () =>
    start(async () => {
      if (!connected) {
        // Checks the credentials where the provider can count, before saving.
        const est = await estimateFeedbackBacklog(def.id, vals, Number(days));
        if (!est.ok) {
          toast.show({ message: connectorError(est.error, def, true), tone: "error" });
          return;
        }
        if (days !== "0" && est.count) {
          const ok = await confirm({
            title: `Pull about ${est.count.toLocaleString()} ${def.noun}?`,
            body: `${aiEnabled
              ? "Autopilot reads each one with AI, from its own monthly allowance. Anything past the allowance waits in the Inbox for review."
              : "Each one lands in the Inbox for review."} Pick a shorter window to start smaller.`,
            confirmLabel: "Connect",
          });
          if (!ok) return;
        }
      }
      const r = await connectFeedbackSource(def.id, vals, Number(days));
      if (r.ok) {
        toast.show({ message: r.message ?? "Connected." });
        setOpen(false);
      } else {
        toast.show({ message: connectorError(r.error, def), tone: "error" });
      }
    });

  return (
    <div className="card" style={{ background: "var(--surface-2, transparent)" }}>
      <div className="card-body col gap-2">
        <div className="row between center" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="col" style={{ gap: 2 }}>
            <span className="text-sm fw-med">{def.name}</span>
            <span className="text-xs muted">{def.blurb}</span>
          </div>
          <div className="row gap-2 center">
            {!connected ? (
              <Pill>Not connected</Pill>
            ) : paused ? (
              <Pill variant="muted">Paused</Pill>
            ) : conn!.status === "error" ? (
              <Pill variant="rust" dot>Error</Pill>
            ) : (
              <Pill ring ringFill>Connected</Pill>
            )}
            {canEdit && (
              <button type="button" className="btn sm ghost" onClick={() => setOpen((v) => !v)}>
                {open ? "Close" : connected ? "Update" : "Connect"}
              </button>
            )}
          </div>
        </div>

        {connected && (
          <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
            {/* Local time: the server's zone and the viewer's can differ. */}
            <span className="text-xs muted" suppressHydrationWarning>
              {conn!.lastSyncedAt ? `Last synced ${gmailTime(conn!.lastSyncedAt)}` : "Not synced yet"}
              {note && !paused ? ` · ${note}` : ""}
            </span>
            {canManage && (
              <>
                {!paused && (
                  <button
                    type="button"
                    className="btn sm ghost"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const r = await syncFeedbackNow(def.id);
                        toast.show({ message: r.ok ? r.message ?? "Synced." : connectorError(r.error, def), tone: r.ok ? "default" : "error" });
                      })
                    }
                  >
                    Sync now
                  </button>
                )}
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      if (!(await confirm({ title: `Disconnect ${def.name}?`, confirmLabel: "Disconnect" }))) return;
                      const r = await disconnectFeedbackSource(def.id);
                      toast.show({ message: r.ok ? "Disconnected." : connectorError(r.error, def), tone: r.ok ? "default" : "error" });
                    })
                  }
                >
                  Disconnect
                </button>
              </>
            )}
          </div>
        )}

        {open && canEdit && (
          <div className="col gap-2" style={{ marginTop: 4 }}>
            {def.fields.map((f) => (
              <label key={f.key} className="col gap-1">
                <span className="eyebrow">{f.label}</span>
                <input
                  className="input"
                  type={f.secret ? "password" : "text"}
                  value={vals[f.key] ?? ""}
                  placeholder={f.secret && connected ? "Enter it again to update" : f.placeholder}
                  onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                  disabled={pending}
                  autoComplete="off"
                />
              </label>
            ))}
            {!connected && (
              <div className="col gap-1">
                <span className="eyebrow">First sync</span>
                <Dropdown
                  ariaLabel="How far back the first sync goes"
                  value={days}
                  onChange={setDays}
                  disabled={pending}
                  buttonStyle={{ width: "100%" }}
                  options={LOOKBACK_OPTIONS}
                />
              </div>
            )}
            <div className="row gap-2">
              <button type="button" className="btn sm" disabled={pending} onClick={connect}>
                {connected ? "Update connection" : "Connect"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
