// Client-safe event catalog (no "server-only"): the canonical list of webhook
// event types + their display labels. Shared by the server-side delivery code
// (lib/webhooks.ts) and the client settings UI (WebhooksPanel). The runtime
// CrumbEvent payload shapes — and a compile-time check that they stay in sync
// with this list — live in lib/webhooks.ts.

export const EVENT_TYPES = [
  "item.created",
  "item.status_changed",
  "item.reply_created",
  "item.assigned",
  "item.merged",
  "item.external_status_changed",
  "ticket.linked",
  "ticket.unlinked",
  "customer.notified",
  "initiative.updated",
  "capture.created",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_LABELS: Record<EventType, string> = {
  "item.created": "Item created",
  "item.status_changed": "Status changed",
  "item.reply_created": "Reply added",
  "item.assigned": "Item assigned",
  "item.merged": "Item merged",
  "item.external_status_changed": "Tracker status changed",
  "ticket.linked": "Ticket linked",
  "ticket.unlinked": "Ticket unlinked",
  "customer.notified": "Customer notified",
  "initiative.updated": "Initiative updated",
  "capture.created": "Capture created",
};

export function isEventType(s: string): s is EventType {
  return (EVENT_TYPES as readonly string[]).includes(s);
}
