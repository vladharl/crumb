import "server-only";
import type { EmailProvider } from "./email/provider";
import { stdoutProvider } from "./email/stdout";
import { makeResendProvider } from "./email/resend";
import { makeSmtpProvider } from "./email/smtp";
import {
  renderMagicLinkHtml, renderMagicLinkText,
  renderReplyNotificationHtml, renderReplyNotificationText,
  renderStatusChangeHtml, renderStatusChangeText,
  renderCustomerReplyNotificationHtml, renderCustomerReplyNotificationText,
} from "./email/template";
import { isCloud } from "./tier";

let cached: { provider: EmailProvider; from: string } | null = null;

// Default From when the operator hasn't set CRUMB_EMAIL_FROM. Only used by
// the stdout provider for log readability; real providers refuse to send
// without a verified sender, which is exactly what we want.
const DEFAULT_FROM = "Crumb <crumb@localhost>";

function selectProvider(): { provider: EmailProvider; from: string } {
  if (cached) return cached;

  const choice = (process.env.CRUMB_EMAIL_PROVIDER ?? "stdout").toLowerCase();
  const from = process.env.CRUMB_EMAIL_FROM ?? DEFAULT_FROM;

  let provider: EmailProvider;
  if (choice === "resend") {
    if (!isCloud()) {
      console.warn("[crumb/email] CRUMB_EMAIL_PROVIDER=resend requires CRUMB_TIER=cloud. Managed email delivery is a Cloud feature — falling back to stdout. Self-hosters can use CRUMB_EMAIL_PROVIDER=smtp with their own relay.");
      provider = stdoutProvider;
    } else {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
        console.warn("[crumb/email] CRUMB_EMAIL_PROVIDER=resend but RESEND_API_KEY is unset — falling back to stdout.");
        provider = stdoutProvider;
      } else if (!process.env.CRUMB_EMAIL_FROM) {
        console.warn("[crumb/email] CRUMB_EMAIL_FROM is unset; Resend will reject sends. Falling back to stdout.");
        provider = stdoutProvider;
      } else {
        provider = makeResendProvider({ apiKey, from });
      }
    }
  } else if (choice === "smtp") {
    // Generic SMTP — OSS-side BYO option. Works on both tiers.
    const host = process.env.SMTP_HOST?.trim();
    const port = parseInt(process.env.SMTP_PORT ?? "587", 10);
    const user = process.env.SMTP_USER ?? "";
    const pass = process.env.SMTP_PASS ?? "";
    const secure = (process.env.SMTP_SECURE ?? "").toLowerCase() === "true";
    if (!host || !Number.isFinite(port)) {
      console.warn("[crumb/email] CRUMB_EMAIL_PROVIDER=smtp but SMTP_HOST/SMTP_PORT not set — falling back to stdout.");
      provider = stdoutProvider;
    } else if (!process.env.CRUMB_EMAIL_FROM) {
      console.warn("[crumb/email] CRUMB_EMAIL_FROM is unset; most SMTP relays will reject sends. Falling back to stdout.");
      provider = stdoutProvider;
    } else {
      provider = makeSmtpProvider({ host, port, user, pass, from, secure });
    }
  } else {
    provider = stdoutProvider;
  }

  cached = { provider, from };
  return cached;
}

export function activeEmailProvider(): { name: string; from: string } {
  const { provider, from } = selectProvider();
  return { name: provider.name, from };
}

// Derive a noreply variant of the configured From — same domain, fixed local
// part. We use this for vendor reply + status-change notifications: until
// inbound mail is wired, customer replies to those emails would be lost, so
// the From itself should signal "don't reply here."
//
// Inputs we handle:
//   "Crumb <crumb@yourdomain.com>"  →  "Crumb (noreply) <noreply@yourdomain.com>"
//   "crumb@yourdomain.com"          →  "noreply@yourdomain.com"
//   anything we can't parse         →  the input verbatim
function noreplyFrom(from: string): string {
  const angle = from.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (angle) {
    const display = angle[1]?.trim();
    const addr = angle[2]!.trim();
    const at = addr.lastIndexOf("@");
    if (at > 0) {
      const domain = addr.slice(at + 1);
      const newDisplay = display ? `${display} (noreply)` : "noreply";
      return `${newDisplay} <noreply@${domain}>`;
    }
  }
  const at = from.lastIndexOf("@");
  if (at > 0) return `noreply@${from.slice(at + 1)}`;
  return from;
}

// Build a deep link the customer can click in an email — opens their host
// product with `?crumb_open=FB-N` so the widget auto-pops the thread.
function buildThreadUrl(productUrl: string | null | undefined, shortId: string): string | null {
  if (!productUrl) return null;
  try {
    const u = new URL(productUrl);
    u.searchParams.set("crumb_open", shortId);
    return u.toString();
  } catch {
    return null;
  }
}

export type MagicLink = {
  to: string;
  link: string;
  ttlMinutes: number;
  workspaceName?: string;
};

export async function sendMagicLink(m: MagicLink): Promise<void> {
  const { provider } = selectProvider();
  const subject = m.workspaceName
    ? `Your Crumb sign-in link · ${m.workspaceName}`
    : "Your Crumb sign-in link";

  const result = await provider.send({
    to: m.to,
    subject,
    html: renderMagicLinkHtml({ workspaceName: m.workspaceName, link: m.link, ttlMinutes: m.ttlMinutes }),
    text: renderMagicLinkText({ workspaceName: m.workspaceName, link: m.link, ttlMinutes: m.ttlMinutes }),
    previewLine: `expires in ${m.ttlMinutes} minutes`,
    link: m.link,
  });

  if (!result.ok) {
    console.error(`[crumb/email] send failed via ${provider.name}: ${result.error}${result.detail ? ` · ${result.detail}` : ""}`);
  }
}

export type ReplyNotification = {
  to: string;
  workspaceName: string;
  vendorName: string;
  itemShortId: string;
  itemTitle: string;
  replyBody: string;
  statusLabel?: string;
  productUrl?: string | null;
  /** When set, used as Reply-To so the customer can reply via email. */
  inboundReplyAddress?: string | null;
};

export async function sendReplyNotification(m: ReplyNotification): Promise<void> {
  const { provider, from } = selectProvider();
  const subject = `${m.vendorName} replied · ${m.itemShortId} ${m.itemTitle}`;
  const threadUrl = buildThreadUrl(m.productUrl, m.itemShortId);

  // If inbound is wired, use the signed reply address so customer replies
  // land back on the thread. Otherwise fall back to a true noreply From.
  const fromAddr = m.inboundReplyAddress ? from : noreplyFrom(from);

  const result = await provider.send({
    to: m.to,
    from: fromAddr,
    ...(m.inboundReplyAddress ? { replyTo: m.inboundReplyAddress } : {}),
    subject,
    html: renderReplyNotificationHtml({
      workspaceName: m.workspaceName,
      vendorName: m.vendorName,
      itemShortId: m.itemShortId,
      itemTitle: m.itemTitle,
      replyBody: m.replyBody,
      statusLabel: m.statusLabel,
      threadUrl,
    }),
    text: renderReplyNotificationText({
      workspaceName: m.workspaceName,
      vendorName: m.vendorName,
      itemShortId: m.itemShortId,
      itemTitle: m.itemTitle,
      replyBody: m.replyBody,
      statusLabel: m.statusLabel,
      threadUrl,
    }),
    previewLine: `${m.vendorName} on ${m.itemShortId}`,
    link: threadUrl ?? undefined,
  });

  if (!result.ok) {
    console.error(`[crumb/email] reply-notification send failed via ${provider.name}: ${result.error}${result.detail ? ` · ${result.detail}` : ""}`);
  }
}

export type StatusChangeNotification = {
  to: string;
  workspaceName: string;
  vendorName: string;
  itemShortId: string;
  itemTitle: string;
  fromStatus: string | null;
  toStatus: string;
  reason?: string | null;
  productUrl?: string | null;
  inboundReplyAddress?: string | null;
};

export async function sendStatusChangeNotification(m: StatusChangeNotification): Promise<void> {
  const { provider, from } = selectProvider();
  const subject = `Status update · ${m.itemShortId} ${m.itemTitle}`;
  const threadUrl = buildThreadUrl(m.productUrl, m.itemShortId);

  const fromAddr = m.inboundReplyAddress ? from : noreplyFrom(from);

  const result = await provider.send({
    to: m.to,
    from: fromAddr,
    ...(m.inboundReplyAddress ? { replyTo: m.inboundReplyAddress } : {}),
    subject,
    html: renderStatusChangeHtml({ ...m, threadUrl }),
    text: renderStatusChangeText({ ...m, threadUrl }),
    previewLine: `${m.fromStatus ?? "—"} → ${m.toStatus}`,
    link: threadUrl ?? undefined,
  });

  if (!result.ok) {
    console.error(`[crumb/email] status-change send failed via ${provider.name}: ${result.error}${result.detail ? ` · ${result.detail}` : ""}`);
  }
}

// ─── Customer-reply notification (to vendor) ─────────────────
// Fires when a customer replies via the widget or via inbound email.
// Goes to the assignee (or all admins if unassigned). Per-recipient
// caller resolves preferences + filters out who shouldn't be notified.

export type CustomerReplyNotification = {
  to: string;                   // single vendor email
  workspaceName: string;
  customerName: string;         // who replied (account_user.name)
  accountName: string;
  itemShortId: string;
  itemTitle: string;
  replyBody: string;
  /** Dashboard URL — built from the host header at call-time. */
  dashboardThreadUrl?: string | null;
};

export async function sendCustomerReplyNotification(m: CustomerReplyNotification): Promise<void> {
  const { provider, from } = selectProvider();
  const subject = `${m.customerName} (${m.accountName}) replied · ${m.itemShortId} ${m.itemTitle}`;
  // Vendor-facing notifications keep the friendly From (not noreply) since
  // we DO want the vendor's mail client to thread these as conversation.
  const result = await provider.send({
    to: m.to,
    from,
    subject,
    html: renderCustomerReplyNotificationHtml({
      workspaceName: m.workspaceName,
      customerName: m.customerName,
      accountName: m.accountName,
      itemShortId: m.itemShortId,
      itemTitle: m.itemTitle,
      replyBody: m.replyBody,
      dashboardThreadUrl: m.dashboardThreadUrl,
    }),
    text: renderCustomerReplyNotificationText({
      workspaceName: m.workspaceName,
      customerName: m.customerName,
      accountName: m.accountName,
      itemShortId: m.itemShortId,
      itemTitle: m.itemTitle,
      replyBody: m.replyBody,
      dashboardThreadUrl: m.dashboardThreadUrl,
    }),
    previewLine: `${m.customerName} on ${m.itemShortId}`,
    link: m.dashboardThreadUrl ?? undefined,
  });

  if (!result.ok) {
    console.error(`[crumb/email] customer-reply send failed via ${provider.name}: ${result.error}${result.detail ? ` · ${result.detail}` : ""}`);
  }
}
