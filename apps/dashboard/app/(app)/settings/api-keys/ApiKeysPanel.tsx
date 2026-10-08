"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Pill } from "@crumb/ui";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/action-error";
import { formatDate } from "@/lib/timefmt";
import { CopySnippetButton } from "@/app/(app)/settings/install/CopySnippetButton";
import { createApiKey, revokeApiKey } from "./actions";

export type KeyView = {
  id: string;
  name: string;
  prefix: string;
  /** The teammate who created the key. The key acts as them. */
  creator: string;
  lastUsedAt: string | null;
  createdAt: string;
};

function used(k: KeyView): string {
  if (!k.lastUsedAt) return "Never used";
  return `Last used ${formatDate(k.lastUsedAt)}`;
}

export function ApiKeysPanel({ initial, isAdmin }: { initial: KeyView[]; isAdmin: boolean }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
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
  async function revoke(k: KeyView) {
    if (!(await confirm({
      title: `Revoke “${k.name}”?`,
      body: `Created by ${k.creator}. Anything connected with this key loses access right away. This can't be undone.`,
      confirmLabel: "Revoke",
      destructive: true,
    }))) return;
    startTransition(async () => {
      const r = await revokeApiKey(k.id);
      if (!r.ok) toast.show({ message: errorMessage(r.error), tone: "error" });
      router.refresh();
    });
  }

  return (
    <div className="col gap-4">
      {created && (
        <div className="col gap-2" style={{ background: "var(--bone-2)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "12px 14px" }}>
          <span className="text-sm fw-med">Key “{created.name}” created. Copy it now</span>
          <span className="text-xs muted">This is the only time the full key is shown. Store it in your MCP client config; you can revoke it here anytime.</span>
          <div className="mono text-xs" style={{ wordBreak: "break-all", background: "var(--surface)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "8px 10px" }}>{created.raw}</div>
          <div className="row gap-2">
            <CopySnippetButton snippet={created.raw} label="Copy key" />
            <Btn sm onClick={() => setCreated(null)}>Done</Btn>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
          <input
            className="input"
            value={name}
            onChange={e => setName(e.target.value)}
            aria-label="Key name"
            placeholder="Key name (e.g. Claude Desktop)"
            style={{ flex: 1, minWidth: 260 }}
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
                <span className="text-xs muted" style={{ wordBreak: "break-all" }}>
                  <span className="mono">{k.prefix}…</span> · Created by {k.creator}
                </span>
              </div>
              <div className="row gap-2 center">
                <Pill ring>{used(k)}</Pill>
                {isAdmin && <Btn sm variant="ghost" onClick={() => revoke(k)} disabled={pending}>Revoke</Btn>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
