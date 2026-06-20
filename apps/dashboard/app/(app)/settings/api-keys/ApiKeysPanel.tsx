"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Pill } from "@crumb/ui";
import { createApiKey, revokeApiKey } from "./actions";

export type KeyView = {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
};

function used(k: KeyView): string {
  if (!k.lastUsedAt) return "Never used";
  return `Last used ${new Date(k.lastUsedAt).toLocaleDateString()}`;
}

export function ApiKeysPanel({ initial, isAdmin }: { initial: KeyView[]; isAdmin: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; raw: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function add() {
    setError(null);
    const fd = new FormData();
    fd.set("name", name);
    startTransition(async () => {
      const r = await createApiKey(fd);
      if (r.ok) { setCreated({ name: r.name, raw: r.raw }); setName(""); router.refresh(); }
      else setError(r.error);
    });
  }
  function revoke(id: string) {
    startTransition(async () => { await revokeApiKey(id); router.refresh(); });
  }

  return (
    <div className="col gap-4">
      {created && (
        <div className="col gap-2" style={{ background: "var(--bone-2)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "12px 14px" }}>
          <span className="text-sm fw-med">Key “{created.name}” created. Copy it now</span>
          <span className="text-xs muted">This is the only time the full key is shown. Store it in your MCP client config; you can revoke it here anytime.</span>
          <div className="mono text-xs" style={{ wordBreak: "break-all", background: "var(--surface)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "8px 10px" }}>{created.raw}</div>
          <div><Btn sm onClick={() => setCreated(null)}>Done</Btn></div>
        </div>
      )}

      {isAdmin && (
        <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Key name (e.g. Claude Desktop)"
            style={{ flex: 1, minWidth: 260, background: "var(--surface)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "8px 10px", font: "inherit", color: "var(--ink)" }}
          />
          <Btn variant="primary" onClick={add} disabled={pending || !name.trim()}>{pending ? "Creating…" : "Create key"}</Btn>
        </div>
      )}
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}

      {initial.length === 0 ? (
        <p className="text-sm muted" style={{ margin: 0 }}>No keys yet. Create one to connect an MCP client to this workspace.</p>
      ) : (
        <div className="col gap-2">
          {initial.map(k => (
            <div key={k.id} className="row between center" style={{ gap: 12, flexWrap: "wrap", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "10px 12px" }}>
              <div className="col gap-1" style={{ flex: 1, minWidth: 200 }}>
                <span className="text-sm fw-med">{k.name}</span>
                <span className="mono text-xs muted" style={{ wordBreak: "break-all" }}>{k.prefix}…</span>
              </div>
              <div className="row gap-2 center">
                <Pill ring>{used(k)}</Pill>
                {isAdmin && <Btn sm variant="ghost" onClick={() => revoke(k.id)} disabled={pending}>Revoke</Btn>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
