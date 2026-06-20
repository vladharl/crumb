"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn, Pill, Switch } from "@crumb/ui";
import { EVENT_TYPES, EVENT_LABELS, type EventType } from "@/lib/event-catalog";
import { createWebhook, deleteWebhook, setWebhookActive, setWebhookEvents, revealWebhookSecret } from "./actions";

export type EndpointView = {
  id: string;
  url: string;
  active: boolean;
  events: string[];
  lastStatus: number | null;
  lastAttemptAt: string | null;
  failureCount: number;
};

function health(ep: EndpointView): { label: string; tone: "ok" | "warn" | "idle" } {
  if (!ep.lastAttemptAt) return { label: "No deliveries yet", tone: "idle" };
  if (ep.lastStatus && ep.lastStatus >= 200 && ep.lastStatus < 300) return { label: `Last delivery ${ep.lastStatus} ✓`, tone: "ok" };
  return { label: `Last delivery ${ep.lastStatus ?? "failed"} · ${ep.failureCount} fail${ep.failureCount === 1 ? "" : "s"}`, tone: "warn" };
}

// Checkbox grid over the event catalog. Pure presentational — parent owns the
// selected set.
function EventPicker({ selected, onToggle, disabled }: { selected: Set<EventType>; onToggle: (t: EventType) => void; disabled?: boolean }) {
  return (
    <div className="row gap-2" style={{ flexWrap: "wrap" }}>
      {EVENT_TYPES.map(t => (
        <label key={t} className="row gap-2 center" style={{ cursor: disabled ? "default" : "pointer", fontSize: "var(--fs-xs, 12px)" }}>
          <input type="checkbox" checked={selected.has(t)} onChange={() => onToggle(t)} disabled={disabled} />
          <span>{EVENT_LABELS[t]}</span>
        </label>
      ))}
    </div>
  );
}

export function WebhooksPanel({ initial, isAdmin }: { initial: EndpointView[]; isAdmin: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [newEvents, setNewEvents] = useState<Set<EventType>>(new Set(EVENT_TYPES));
  const [error, setError] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<{ url: string; secret: string } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, Set<EventType>>>({});
  const [pending, startTransition] = useTransition();

  function toggleNew(t: EventType) {
    setNewEvents(s => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; });
  }

  function add() {
    setError(null);
    if (newEvents.size === 0) { setError("Pick at least one event."); return; }
    const fd = new FormData();
    fd.set("url", url);
    fd.set("events", JSON.stringify([...newEvents]));
    startTransition(async () => {
      const r = await createWebhook(fd);
      if (r.ok) { setCreatedSecret({ url: r.url, secret: r.secret }); setUrl(""); setNewEvents(new Set(EVENT_TYPES)); router.refresh(); }
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
  function startEdit(ep: EndpointView) {
    setEditing(s => ({ ...s, [ep.id]: new Set(ep.events.filter((e): e is EventType => (EVENT_TYPES as readonly string[]).includes(e))) }));
  }
  function toggleEdit(id: string, t: EventType) {
    setEditing(s => { const cur = new Set(s[id] ?? []); cur.has(t) ? cur.delete(t) : cur.add(t); return { ...s, [id]: cur }; });
  }
  function saveEvents(id: string) {
    const sel = editing[id];
    if (!sel || sel.size === 0) { setError("Pick at least one event."); return; }
    startTransition(async () => {
      const r = await setWebhookEvents(id, [...sel]);
      if (r.ok) { setEditing(s => { const n = { ...s }; delete n[id]; return n; }); router.refresh(); }
      else setError(r.error);
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
        <div className="col gap-2">
          <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
            <input
              className="minw-relax"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://your-app.example.com/crumb/webhook"
              style={{ flex: 1, minWidth: 260, background: "var(--surface)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "8px 10px", font: "inherit", color: "var(--ink)" }}
            />
            <Btn variant="primary" onClick={add} disabled={pending || !url.trim()}>{pending ? "Adding…" : "Add endpoint"}</Btn>
          </div>
          <EventPicker selected={newEvents} onToggle={toggleNew} disabled={pending} />
        </div>
      )}
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}

      {initial.length === 0 ? (
        <p className="text-sm muted" style={{ margin: 0 }}>No endpoints yet. Add one to receive signed event POSTs (created, status changed, replied, assigned, merged).</p>
      ) : (
        <div className="col gap-2">
          {initial.map(ep => {
            const h = health(ep);
            const editSet = editing[ep.id];
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

                {editSet ? (
                  <div className="col gap-2">
                    <EventPicker selected={editSet} onToggle={t => toggleEdit(ep.id, t)} disabled={pending} />
                    <div className="row gap-2">
                      <Btn sm variant="primary" onClick={() => saveEvents(ep.id)} disabled={pending}>Save events</Btn>
                      <Btn sm variant="ghost" onClick={() => setEditing(s => { const n = { ...s }; delete n[ep.id]; return n; })} disabled={pending}>Cancel</Btn>
                    </div>
                  </div>
                ) : (
                  <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
                    {ep.events.map(e => (
                      <Pill key={e} ring>{EVENT_LABELS[e as EventType] ?? e}</Pill>
                    ))}
                  </div>
                )}

                {revealed[ep.id] && (
                  <div className="mono text-xs" style={{ wordBreak: "break-all", background: "var(--bone-2)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "6px 8px" }}>{revealed[ep.id]}</div>
                )}
                {isAdmin && !editSet && (
                  <div className="row gap-2">
                    <Btn sm variant="ghost" onClick={() => startEdit(ep)} disabled={pending}>Edit events</Btn>
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
