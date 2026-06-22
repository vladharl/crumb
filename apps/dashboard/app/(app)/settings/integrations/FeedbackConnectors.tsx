"use client";

import { useState, useTransition } from "react";
import { Card, CardHead, Pill } from "@crumb/ui";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm";
import { connectFeedbackSource, disconnectFeedbackSource, syncFeedbackNow } from "./FeedbackConnectorsActions";
import type { ConnectionView } from "@/lib/integrations/feedback/connections";
import type { FeedbackProvider } from "@/lib/integrations/feedback/types";

type Field = { key: string; label: string; secret?: boolean; placeholder?: string; configKey?: keyof ConnectionView["config"] };
type ProviderDef = { id: FeedbackProvider; name: string; blurb: string; fields: Field[] };

// What each connector pulls + the creds it needs. Non-secret fields prefill from
// the saved config; secrets are write-only (blank with a "set" hint).
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
  },
  {
    id: "freshdesk",
    name: "Freshdesk",
    blurb: "Pull tickets updated since the last sync.",
    fields: [
      { key: "domain", label: "Domain", placeholder: "acme", configKey: "domain" },
      { key: "apiKey", label: "API key", secret: true },
    ],
  },
  {
    id: "intercom",
    name: "Intercom",
    blurb: "Pull conversations; turn the product feedback in them into items.",
    fields: [{ key: "accessToken", label: "Access token", secret: true }],
  },
  {
    id: "freshchat",
    name: "Freshchat",
    blurb: "Pull chat conversations (webhook ingest is the recommended follow-up).",
    fields: [
      { key: "baseUrl", label: "API base URL", placeholder: "https://acme.freshchat.com/v2", configKey: "baseUrl" },
      { key: "apiToken", label: "API token", secret: true },
    ],
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
  },
];

export function FeedbackConnectors({
  connections,
  canManage,
  aiEnabled,
}: {
  connections: ConnectionView[];
  canManage: boolean;
  aiEnabled: boolean;
}) {
  const byProvider = new Map(connections.map((c) => [c.provider, c]));
  return (
    <Card>
      <CardHead
        title="Feedback sources (Autopilot)"
        after={<Pill>{connections.length ? `${connections.length} connected` : "Inbound"}</Pill>}
      />
      <div className="col gap-3" style={{ padding: "0 4px 4px" }}>
        <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "64ch" }}>
          Pull feedback from where customers already talk. {aiEnabled
            ? "New, relevant items are added automatically; near-duplicates fold into the existing item; anything unclear waits in the Inbox."
            : "On self-host, every pulled record lands in the Inbox for review (the AI new-and-relevant filter is a Cloud feature)."}
        </p>
        {PROVIDERS.map((p) => (
          <ConnectorRow key={p.id} def={p} conn={byProvider.get(p.id)} canManage={canManage} />
        ))}
      </div>
    </Card>
  );
}

function ConnectorRow({ def, conn, canManage }: { def: ProviderDef; conn?: ConnectionView; canManage: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of def.fields) if (f.configKey) init[f.key] = (conn?.config?.[f.configKey] as string) ?? "";
    return init;
  });
  const [pending, start] = useTransition();
  const connected = !!conn;

  return (
    <div className="card" style={{ background: "var(--surface-2, transparent)" }}>
      <div className="card-body col gap-2">
        <div className="row between center" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="col" style={{ gap: 2 }}>
            <span className="text-sm fw-med">{def.name}</span>
            <span className="text-xs muted">{def.blurb}</span>
          </div>
          <div className="row gap-2 center">
            {connected ? (
              <Pill ring ringFill>
                {conn!.status === "error" ? "Error" : "Connected"}
              </Pill>
            ) : (
              <Pill>Not connected</Pill>
            )}
            {canManage && (
              <button type="button" className="btn sm ghost" onClick={() => setOpen((v) => !v)}>
                {open ? "Close" : connected ? "Update" : "Connect"}
              </button>
            )}
          </div>
        </div>

        {connected && (
          <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
            <span className="text-xs muted">
              {conn!.lastSyncedAt ? `Last synced ${new Date(conn!.lastSyncedAt).toLocaleString()}` : "Not synced yet"}
              {conn!.lastError ? ` · ${conn!.lastError}` : ""}
            </span>
            {canManage && (
              <>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await syncFeedbackNow(def.id);
                      toast.show({ message: r.ok ? r.message ?? "Synced." : `Sync failed (${r.error}).`, tone: r.ok ? "default" : "error" });
                    })
                  }
                >
                  Sync now
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      if (!(await confirm({ title: `Disconnect ${def.name}?`, confirmLabel: "Disconnect" }))) return;
                      const r = await disconnectFeedbackSource(def.id);
                      toast.show({ message: r.ok ? "Disconnected." : `Couldn't disconnect (${r.error}).`, tone: r.ok ? "default" : "error" });
                    })
                  }
                >
                  Disconnect
                </button>
              </>
            )}
          </div>
        )}

        {open && canManage && (
          <div className="col gap-2" style={{ marginTop: 4 }}>
            {def.fields.map((f) => (
              <label key={f.key} className="col gap-1">
                <span className="eyebrow">{f.label}</span>
                <input
                  className="input"
                  type={f.secret ? "password" : "text"}
                  value={vals[f.key] ?? ""}
                  placeholder={f.secret && connected ? "•••• (leave blank to keep)" : f.placeholder}
                  onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                  disabled={pending}
                  autoComplete="off"
                />
              </label>
            ))}
            <div className="row gap-2">
              <button
                type="button"
                className="btn sm"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await connectFeedbackSource(def.id, vals);
                    if (r.ok) {
                      toast.show({ message: r.message ?? "Connected." });
                      setOpen(false);
                    } else {
                      toast.show({ message: `Couldn't connect (${r.error}).`, tone: "error" });
                    }
                  })
                }
              >
                {connected ? "Update connection" : "Connect"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
