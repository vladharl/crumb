"use client";

import { useState, useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Btn, Pill, Switch } from "@crumb/ui";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/action-error";
import { CopySnippetButton } from "@/app/(app)/settings/install/CopySnippetButton";
import { EVENT_TYPES, EVENT_LABELS, type EventType } from "@/lib/event-catalog";
import {
  createWebhook, deleteWebhook, setWebhookActive, setWebhookEvents, revealWebhookSecret,
  rotateWebhookSecret, sendTestWebhook,
} from "./actions";

// One delivery attempt, already in words (the page maps codes server-side).
export type DeliveryView = {
  id: string;
  at: string;   // ISO, shown on hover
  ago: string;  // "3m", "2h"
  event: string;
  attempt: number;
  httpStatus: number | null;
  ok: boolean;
  result: string;
};

export type EndpointView = {
  id: string;
  url: string;
  active: boolean;
  events: string[];
  failureCount: number;
  deliveries: DeliveryView[]; // newest first
};

function streak(ep: EndpointView): string | null {
  if (ep.failureCount === 0) return null;
  const n = `${ep.failureCount} failed ${ep.failureCount === 1 ? "event" : "events"} in a row.`;
  return ep.active ? n : `${n} Turn it back on once your receiver is healthy.`;
}

const cell: CSSProperties = { padding: "6px 12px 6px 0", textAlign: "left", fontWeight: 400, whiteSpace: "nowrap" };

function DeliveryLog({ deliveries }: { deliveries: DeliveryView[] }) {
  if (deliveries.length === 0) return <span className="text-xs muted">No deliveries yet.</span>;
  return (
    <details>
      <summary className="text-xs" style={{ color: "var(--ink)" }}>Recent deliveries ({deliveries.length})</summary>
      <div style={{ overflowX: "auto", marginTop: 6 }}>
        <table className="text-xs" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr className="muted">
              <th style={cell}>When</th><th style={cell}>Event</th><th style={cell}>Attempt</th><th style={cell}>Status</th><th style={cell}>Result</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map(d => (
              <tr key={d.id} style={{ borderTop: "var(--border)" }}>
                <td style={cell} className="mono" title={d.at}>{d.ago}</td>
                <td style={cell}>{d.event}</td>
                <td style={cell} className="mono">{d.attempt}</td>
                <td style={cell} className="mono">{d.httpStatus ?? "None"}</td>
                <td style={{ ...cell, whiteSpace: "normal", minWidth: 180, color: d.ok ? "var(--ink)" : "var(--err-text)" }}>{d.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
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

const secretBox: CSSProperties = { wordBreak: "break-all", background: "var(--surface)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "8px 10px" };

export function WebhooksPanel({ initial, isAdmin }: { initial: EndpointView[]; isAdmin: boolean }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [newEvents, setNewEvents] = useState<Set<EventType>>(new Set(EVENT_TYPES));
  const [error, setError] = useState<string | null>(null);
  // A secret shown once, right after create or rotate.
  const [fresh, setFresh] = useState<{ title: string; note: string; secret: string } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, Set<EventType>>>({});
  const [pending, startTransition] = useTransition();

  function toggleNew(t: EventType) {
    setNewEvents(s => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; });
  }
  function hideSecret(id: string) {
    setRevealed(s => { const n = { ...s }; delete n[id]; return n; });
  }

  function add() {
    setError(null);
    if (newEvents.size === 0) { setError("Pick at least one event."); return; }
    const fd = new FormData();
    fd.set("url", url);
    fd.set("events", JSON.stringify([...newEvents]));
    startTransition(async () => {
      const r = await createWebhook(fd);
      if (r.ok) {
        setFresh({
          title: "Endpoint added. Save this signing secret now",
          note: "It verifies the X-Crumb-Signature header. You can reveal it again later, but store it on your receiver now.",
          secret: r.secret,
        });
        setUrl(""); setNewEvents(new Set(EVENT_TYPES)); router.refresh();
      } else setError(errorMessage(r.error));
    });
  }
  function toggle(id: string, active: boolean) {
    startTransition(async () => {
      const r = await setWebhookActive(id, active);
      if (!r.ok) toast.show({ message: errorMessage(r.error), tone: "error" });
      router.refresh();
    });
  }
  async function remove(ep: EndpointView) {
    if (!(await confirm({
      title: "Delete this endpoint?",
      body: `${ep.url} stops receiving events right away, and its delivery log is deleted. This can't be undone.`,
      confirmLabel: "Delete",
      destructive: true,
    }))) return;
    startTransition(async () => {
      const r = await deleteWebhook(ep.id);
      if (!r.ok) toast.show({ message: errorMessage(r.error), tone: "error" });
      router.refresh();
    });
  }
  async function rotate(ep: EndpointView) {
    if (!(await confirm({
      title: "Rotate the signing secret?",
      body: "The current secret stops working right away, so deliveries fail verification until your receiver has the new one.",
      confirmLabel: "Rotate",
      destructive: true,
    }))) return;
    startTransition(async () => {
      const r = await rotateWebhookSecret(ep.id);
      if (!r.ok) { toast.show({ message: errorMessage(r.error), tone: "error" }); return; }
      hideSecret(ep.id);
      setFresh({
        title: "New signing secret. Copy it now",
        note: `The old secret no longer works for ${ep.url}. Put this one on your receiver.`,
        secret: r.secret,
      });
    });
  }
  function sendTest(id: string) {
    startTransition(async () => {
      const r = await sendTestWebhook(id);
      if (r.ok) toast.show({ message: r.message, tone: r.delivered ? "default" : "error" });
      else toast.show({ message: errorMessage(r.error), tone: "error" });
      router.refresh();
    });
  }
  function reveal(id: string) {
    startTransition(async () => {
      const r = await revealWebhookSecret(id);
      if (r.ok) setRevealed(s => ({ ...s, [id]: r.secret }));
      else toast.show({ message: errorMessage(r.error), tone: "error" });
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
      else setError(errorMessage(r.error));
    });
  }

  return (
    <div className="col gap-4">
      {fresh && (
        <div className="col gap-2" style={{ background: "var(--bone-2)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "12px 14px" }}>
          <span className="text-sm fw-med">{fresh.title}</span>
          <span className="text-xs muted">{fresh.note}</span>
          <div className="mono text-xs" style={secretBox}>{fresh.secret}</div>
          <div className="row gap-2">
            <CopySnippetButton snippet={fresh.secret} label="Copy secret" />
            <Btn sm onClick={() => setFresh(null)}>Done</Btn>
          </div>
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
              aria-label="Endpoint URL"
              style={{ flex: 1, minWidth: 260, background: "var(--surface)", border: "var(--border)", borderRadius: "var(--r-sm)", padding: "8px 10px", font: "inherit", color: "var(--ink)" }}
            />
            <Btn variant="primary" onClick={add} disabled={pending || !url.trim()}>{pending ? "Adding…" : "Add endpoint"}</Btn>
          </div>
          <EventPicker selected={newEvents} onToggle={toggleNew} disabled={pending} />
        </div>
      )}
      {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{error}</span>}

      {initial.length === 0 ? (
        <p className="text-sm muted" style={{ margin: 0 }}>No endpoints yet. Add one to receive signed event POSTs.</p>
      ) : (
        <div className="col gap-2">
          {initial.map(ep => {
            const editSet = editing[ep.id];
            const note = streak(ep);
            return (
              <div key={ep.id} className="col gap-2" style={{ border: "var(--border)", borderRadius: "var(--r-sm)", padding: "10px 12px" }}>
                <div className="row between center" style={{ gap: 12, flexWrap: "wrap" }}>
                  <span className="mono text-xs" style={{ wordBreak: "break-all", flex: 1 }}>{ep.url}</span>
                  <div className="row gap-2 center">
                    <Pill ring ringFill={ep.active}>{ep.active ? "Active" : "Paused"}</Pill>
                    {isAdmin && <Switch on={ep.active} onClick={() => toggle(ep.id, !ep.active)} />}
                  </div>
                </div>
                {note && <span className="text-xs" style={{ color: "var(--err-text)" }}>{note}</span>}

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
                  <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
                    <div className="mono text-xs" style={{ ...secretBox, flex: 1, minWidth: 200 }}>{revealed[ep.id]}</div>
                    <CopySnippetButton snippet={revealed[ep.id]!} label="Copy secret" />
                    <Btn sm variant="ghost" onClick={() => hideSecret(ep.id)}>Hide</Btn>
                  </div>
                )}
                {isAdmin && !editSet && (
                  <div className="row gap-2" style={{ flexWrap: "wrap" }}>
                    <Btn sm variant="ghost" onClick={() => startEdit(ep)} disabled={pending}>Edit events</Btn>
                    <Btn sm variant="ghost" onClick={() => sendTest(ep.id)} disabled={pending}>Send test</Btn>
                    <Btn sm variant="ghost" onClick={() => reveal(ep.id)} disabled={pending}>Reveal secret</Btn>
                    <Btn sm variant="ghost" onClick={() => rotate(ep)} disabled={pending}>Rotate secret</Btn>
                    <Btn sm variant="ghost" onClick={() => remove(ep)} disabled={pending}>Delete</Btn>
                  </div>
                )}

                <DeliveryLog deliveries={ep.deliveries} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
