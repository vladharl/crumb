import "server-only";
import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { open } from "@/lib/crypto-at-rest";
import { assertSafeWebhookUrl } from "./url-guard";
import { log } from "@/lib/log";

// Unified chat-webhook layer (both editions, plain fetch). One abstraction
// covers vendor Teams + customer Slack/Teams: post a card to a channel webhook.
// Slack uses Block Kit; Teams uses an Adaptive Card in the Workflows envelope.

const TIMEOUT_MS = 10_000;

export type ChatEvent =
  | { kind: "new_submission"; shortId: string; title: string; type: string; accountName: string; submitterName: string; url: string | null }
  | { kind: "vendor_reply"; shortId: string; title: string; vendorName: string; body: string; url: string | null }
  | { kind: "customer_reply"; shortId: string; title: string; accountName: string; customerName: string; body: string; url: string | null }
  | { kind: "status_change"; shortId: string; title: string; fromStatus: string | null; toStatus: string; reason: string | null; url: string | null }
  | { kind: "roadmap_update"; initiativeName: string; change: string; url: string | null };

function clip(s: string, n = 280): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function headline(e: ChatEvent): string {
  switch (e.kind) {
    case "new_submission": return `New ${e.type}: ${e.title}`;
    case "vendor_reply":   return `Reply on ${e.shortId}`;
    case "customer_reply": return `${e.customerName} replied on ${e.shortId}`;
    case "status_change":  return `${e.shortId} → ${e.toStatus}`;
    case "roadmap_update": return `Roadmap update: ${e.initiativeName}`;
  }
}
function detail(e: ChatEvent): string {
  switch (e.kind) {
    case "new_submission": return `From ${e.submitterName} at ${e.accountName} · ${e.shortId}`;
    case "vendor_reply":   return `${e.vendorName}: ${clip(e.body)}`;
    case "customer_reply": return `${e.accountName}: ${clip(e.body)}`;
    case "status_change":  return e.reason ? `${e.title}: ${clip(e.reason)}` : e.title;
    case "roadmap_update": return e.change;
  }
}

function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function slackBlocksFor(e: ChatEvent): { text: string; blocks: unknown[] } {
  const text = `${headline(e)}\n${detail(e)}`;
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${escapeSlack(headline(e))}*\n${escapeSlack(detail(e))}` } },
  ];
  if (e.url) {
    blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open" }, url: e.url }] });
  }
  return { text, blocks };
}

export function teamsCardFor(e: ChatEvent): unknown {
  const body = [
    { type: "TextBlock", text: headline(e), weight: "Bolder", size: "Medium", wrap: true },
    { type: "TextBlock", text: detail(e), wrap: true, isSubtle: true },
  ];
  const actions = e.url ? [{ type: "Action.OpenUrl", title: "Open", url: e.url }] : [];
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
    actions,
  };
}

async function postJson(url: string, payload: unknown): Promise<{ ok: boolean; error?: string }> {
  const guard = assertSafeWebhookUrl(url);
  if (!guard.ok) return { ok: false, error: guard.error };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(guard.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return resp.ok ? { ok: true } : { ok: false, error: `http_${resp.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "post_failed" };
  } finally {
    clearTimeout(timer);
  }
}

export function postSlackWebhook(url: string, msg: { text: string; blocks?: unknown[] }) {
  return postJson(url, { text: msg.text, blocks: msg.blocks });
}

export function postTeamsWebhook(url: string, card: unknown) {
  // Workflows / incoming-webhook envelope for an Adaptive Card.
  return postJson(url, {
    type: "message",
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
  });
}

// Vendor-side Teams firehose: post key events to the workspace's Teams channel
// webhook (if set). Best-effort, never throws.
export async function notifyWorkspaceChannel(workspaceId: string, event: ChatEvent): Promise<void> {
  try {
    const [ws] = await db
      .select({ teamsWebhookUrl: workspaces.teamsWebhookUrl })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!ws?.teamsWebhookUrl) return;
    let url: string;
    try { url = open(ws.teamsWebhookUrl); } catch { return; }
    const r = await postTeamsWebhook(url, teamsCardFor(event));
    if (!r.ok) log.warn("vendor teams webhook failed", { scope: "crumb/notify", error: r.error });
  } catch (err) {
    log.error("notifyWorkspaceChannel failed", { scope: "crumb/notify", err });
  }
}
