// Where an item came from, and who we may auto-email about it. Pure (no DB /
// server-only) so it's shared by server mutations and the changelog fan-out.
//
// Auto-notification (status changes, vendor replies, ship announcements) is
// reserved for customers who raised their feedback THROUGH THE WIDGET — an owned
// channel they opted into. Customers pulled in from external tools (Gong,
// Zendesk, Intercom, Freshdesk, Freshchat) — or forwarded in from email/Slack —
// never opted into Crumb's loop, so we don't surprise them with email; the vendor
// follows up in the original tool, or the customer hears it if they later adopt
// the widget. Legacy items (source NULL, predating connectors + this rule) were
// widget-submitted, so they remain notifiable.

export const WIDGET_SOURCE = "widget";

// Inbound feedback connectors (the pulled sources). Mirrors FEEDBACK_PROVIDERS.
export const PULLED_CONNECTOR_SOURCES = new Set(["gong", "zendesk", "intercom", "freshdesk", "freshchat"]);

export function isPulledConnectorSource(source: string | null | undefined): boolean {
  return source != null && PULLED_CONNECTOR_SOURCES.has(source);
}

// May we auto-email the submitter of an item with this source? Only widget-origin
// (explicit "widget") and legacy NULL items qualify; every explicit non-widget
// source (connectors, email/slack/extension captures) is excluded.
export function autoNotifiesSubmitter(source: string | null | undefined): boolean {
  return source == null || source === WIDGET_SOURCE;
}
