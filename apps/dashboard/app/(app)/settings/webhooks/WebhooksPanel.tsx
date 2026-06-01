"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Ic, Pill, Switch } from "@crumb/ui";
import { createWebhook, deleteWebhook, setWebhookActive, revealWebhookSecret } from "./actions";

export type EndpointView = {
  id: string;
  url: string;
  active: boolean;
  lastStatus: number | null;
  lastAttemptAt: string | null;
  failureCount: number;
};

function health(ep: EndpointView): { label: string; tone: "ok" | "warn" | "idle" } {
  if (!ep.lastAttemptAt) return { label: "No deliveries yet", tone: "idle" };
  if (ep.lastStatus && ep.lastStatus >= 200 && ep.lastStatus < 300) return { label: `Last delivery ${ep.lastStatus} ✓`, tone: "ok" };
  return { label: `Last delivery ${ep.lastStatus ?? "failed"} · ${ep.failureCount} fail${ep.failureCount === 1 ? "" : "s"}`, tone: "warn" };
}

export function WebhooksPanel({ initial, isAdmin }: { initial: EndpointView[]; isAdmin: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<{ url: string; secret: string } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  function add() {
    setError(null);
    const fd = new FormData();
    fd.set("url", url);
    startTransition(async () => {
      const r = await createWebhook(fd);
      if (r.ok) { setCreatedSecret({ url: r.url, secret: r.secret }); setUrl(""); router.refresh(); }
      else setError(r.error);
    });
  }
  function toggle(id: string, active: boolean) {
    startTransition(async () => { await setWebhookActive(id, active); router.refresh(); });
  }
  function remove(id: string) {
    startTransition(async () => { await deleteWebhook(id); router.refresh(); });
  }
  function reveal(id: string) {
    startTransition(async () => {
      const r = await revealWebhookSecret(id);
      if (r.ok) setRevealed(s => ({ ...s, [id]: r.secret }));
    });
  }

  return (
    <div className="col gap-4">
      {createdSecret && (
        <div className="col gap-2" style={{ background: "var(--bone-2)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "12px 14px" }}>
          <span className="text-sm fw-med">Endpoint added. Save this signing secret now</span>
          <span className="text-xs muted">It's used to verify the <span className="mono">X-Crumb-Signature</span> header. You can re-reveal it later, but store it on your receiver now.</span>
          <div className="mono text-xs" style={{ wordBreak: "break-all", background: "var(--surface)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "8px 10px" }}>{createdSecret.secret}</div>
          <div><Btn sm onClick={() => setCreatedSecret(null)}>Done</Btn></div>
        </div>
      )}

      {isAdmin && (
        <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://your-app.example.com/crumb/webhook"
            style={{ flex: 1, minWidth: 260, background: "var(--surface)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "8px 10px", font: "inherit", color: "var(--ink)" }}
          />
          <Btn variant="primary" onClick={add} disabled={pending || !url.trim()}>{pending ? "Adding…" : "Add endpoint"}</Btn>
        </div>
      )}
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}

      {initial.length === 0 ? (
        <p className="text-sm muted" style={{ margin: 0 }}>No endpoints yet. Add one to receive a signed <span className="mono">item.status_changed</span> POST whenever you move an item's status.</p>
      ) : (
        <div className="col gap-2">
          {initial.map(ep => {
            const h = health(ep);
            return (
              <div key={ep.id} className="col gap-2" style={{ border: "var(--border)", borderRadius: "var(--r-sm)", padding: "10px 12px" }}>
                <div className="row between center" style={{ gap: 12, flexWrap: "wrap" }}>
                  <span className="mono text-xs" style={{ wordBreak: "break-all", flex: 1 }}>{ep.url}</span>
                  <div className="row gap-2 center">
                    <Pill ring ringFill={h.tone === "ok"}>{ep.active ? "Active" : "Paused"}</Pill>
                    {isAdmin && <Switch on={ep.active} onClick={() => toggle(ep.id, !ep.active)} />}
                  </div>
                </div>
                <span className="text-xs" style={{ color: h.tone === "warn" ? "var(--err-text)" : "var(--mute)" }}>{h.label}</span>
                {revealed[ep.id] && (
                  <div className="mono text-xs" style={{ wordBreak: "break-all", background: "var(--bone-2)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "6px 8px" }}>{revealed[ep.id]}</div>
                )}
                {isAdmin && (
                  <div className="row gap-2">
                    <Btn sm variant="ghost" onClick={() => reveal(ep.id)} disabled={pending}>Reveal secret</Btn>
                    <Btn sm variant="ghost" onClick={() => remove(ep.id)} disabled={pending}>Delete</Btn>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
