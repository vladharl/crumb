import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { statusLabel } from "@crumb/ui";
import type { EmailProvider, OutgoingEmail, SendResult } from "./email/provider";
import { stdoutProvider } from "./email/stdout";
import { makeResendProvider } from "./email/resend";
import { makeSmtpProvider } from "./email/smtp";
import {
  renderMagicLinkHtml, renderMagicLinkText,
  renderSignupVerifyHtml, renderSignupVerifyText,
  renderInviteHtml, renderInviteText,
  renderReplyNotificationHtml, renderReplyNotificationText,
  renderStatusChangeHtml, renderStatusChangeText,
  renderCustomerReplyNotificationHtml, renderCustomerReplyNotificationText,
  renderMentionHtml, renderMentionText,
  renderDunningHtml, renderDunningText,
  renderRoadmapUpdateHtml, renderRoadmapUpdateText,
  renderShippedAnnouncementHtml, renderShippedAnnouncementText,
  renderSignupNotificationHtml, renderSignupNotificationText,
  renderSupportRequestHtml, renderSupportRequestText,
  renderVendorNudgeHtml, renderVendorNudgeText,
  renderDigestHtml, renderDigestText,
  renderPublicFollowConfirmHtml, renderPublicFollowConfirmText,
  renderPublicFollowUpdateHtml, renderPublicFollowUpdateText,
  type DigestVars, type PublicFollowConfirmVars, type PublicFollowUpdateVars,
} from "./email/template";
import { isCloud } from "./tier";
import { log } from "./log";

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
      console.warn("[crumb/email] CRUMB_EMAIL_PROVIDER=resend requires CRUMB_TIER=cloud. Managed email delivery is a Cloud feature, so email falls back to stdout. Self-hosters can use CRUMB_EMAIL_PROVIDER=smtp with their own relay.");
      provider = stdoutProvider;
    } else {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
        console.warn("[crumb/email] CRUMB_EMAIL_PROVIDER=resend but RESEND_API_KEY is unset. Falling back to stdout.");
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
    // Empty counts as unset: docker-compose passes a blank SMTP_PORT through.
    const port = parseInt(process.env.SMTP_PORT?.trim() || "587", 10);
    const user = process.env.SMTP_USER ?? "";
    const pass = process.env.SMTP_PASS ?? "";
    const secure = (process.env.SMTP_SECURE ?? "").toLowerCase() === "true";
    if (!host || !Number.isFinite(port)) {
      console.warn("[crumb/email] CRUMB_EMAIL_PROVIDER=smtp but SMTP_HOST/SMTP_PORT not set. Falling back to stdout.");
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

// True only when a real, deliverable provider is configured (resend/smtp) — not
// the stdout fallback. Drives whether we expose customer notification settings:
// a self-hoster who hasn't wired email shouldn't be offered prefs we can't honor.
export function emailConfigured(): boolean {
  return activeEmailProvider().name !== "stdout";
}

// Where in-app support messages are delivered. Explicit CRUMB_SUPPORT_EMAIL wins;
// otherwise fall back to the operator address (CRUMB_OPS_EMAIL). Null when neither
// is set — the in-app contact form stays hidden in that case.
export function supportContactAddress(): string | null {
  const explicit = process.env.CRUMB_SUPPORT_EMAIL?.trim();
  if (explicit) return explicit;
  const ops = process.env.CRUMB_OPS_EMAIL?.trim();
  return ops || null;
}

// The in-app Help → Contact form is offered only when email can actually be
// delivered AND a destination is configured. Never show a form we can't honor.
export function supportContactEnabled(): boolean {
  return emailConfigured() && supportContactAddress() !== null;
}

// The one door every email leaves through. It refuses reserved-TLD
// placeholders (RFC 2606 .invalid: Slack captures with no address get
// x@slack.invalid, sample customers and the Install preview use them too), so
// no path can send to one, and logs a provider failure.
async function deliver(kind: string, m: OutgoingEmail): Promise<SendResult> {
  const { provider } = selectProvider();
  if (/\.invalid\.?$/i.test(senderAddress(m.to))) {
    log.info("email not sent: placeholder address", { scope: "crumb/email", kind });
    return { ok: false, error: "invalid_recipient" };
  }
  const result = await provider.send(m);
  if (!result.ok) {
    log.error(`${kind} send failed`, { scope: "crumb/email", provider: provider.name, error: result.error, detail: result.detail });
  }
  return result;
}

// Derive a noreply variant of the configured From — same domain, fixed local
// part. Used for one-way notices (signup, support, dunning, and customer
// emails nobody can reply to) so the From itself signals "don't reply here."
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

// ─── Customer-facing sender + headers ────────────────────────
// What a vendor's customers get reads as the vendor's: "<Workspace> via Crumb"
// on the verified CRUMB_EMAIL_FROM address, or its noreply@ twin when no
// reply-by-email address rides along (a reply would land in no thread).
// Quotes, backslashes and line breaks are dropped from the name rather than
// escaped, which every provider accepts.

const senderAddress = (from: string) => from.match(/<([^>]+)>/)?.[1]?.trim() ?? from.trim();

function customerFrom(workspaceName: string, from: string): string {
  const name = `${workspaceName} via Crumb`.replace(/\s+/g, " ").replace(/["\\]/g, "");
  return `"${name}" <${senderAddress(from)}>`;
}

// One-click unsubscribe (RFC 8058) on the footer's own per-customer link.
// Threading: every email about one item (or initiative) points at one root id
// derived from the workspace and the item, while its own Message-ID stays
// unique (Gmail drops a repeated Message-ID as a duplicate).
// ponytail: keyed on the workspace name (senders don't get its id), so a rename
// starts a new thread.
// ponytail: https only. A mailto twin needs an inbound handler that applies it
// (none yet); without one, mail apps that prefer mailto would report an
// unsubscribe that never happened.
function customerHeaders(
  from: string,
  workspaceName: string,
  threadKey: string,
  unsubscribeUrl?: string | null,
): Record<string, string> {
  const domain = senderAddress(from).split("@")[1] || "localhost";
  const root = `<${createHash("sha256").update(`${workspaceName}\n${threadKey}`).digest("hex").slice(0, 32)}@${domain}>`;
  const headers: Record<string, string> = {
    "Message-ID": `<${randomUUID()}@${domain}>`,
    "In-Reply-To": root,
    References: root,
  };
  if (unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  return headers;
}

export type MagicLink = {
  to: string;
  link: string;
  ttlMinutes: number;
  workspaceName?: string;
};

export async function sendMagicLink(m: MagicLink): Promise<void> {
  const subject = m.workspaceName
    ? `Your Crumb sign-in link · ${m.workspaceName}`
    : "Your Crumb sign-in link";

  await deliver("magic-link", {
    to: m.to,
    subject,
    html: renderMagicLinkHtml({ workspaceName: m.workspaceName, link: m.link, ttlMinutes: m.ttlMinutes }),
    text: renderMagicLinkText({ workspaceName: m.workspaceName, link: m.link, ttlMinutes: m.ttlMinutes }),
    previewLine: `expires in ${ttlText(m.ttlMinutes)}`,
    link: m.link,
  });
}

// Team invite: its own email (not the bare sign-in one), carrying a regular
// magic-link token as its single button.
export type Invite = {
  to: string;
  link: string;
  ttlMinutes: number;
  workspaceName: string;
  inviterName: string;
};

// "15 minutes", "24 hours", "7 days" for the stdout preview operators read.
function ttlText(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export async function sendInvite(m: Invite): Promise<void> {
  await deliver("invite", {
    to: m.to,
    subject: `${m.inviterName} invited you to ${m.workspaceName} on Crumb`,
    html: renderInviteHtml(m),
    text: renderInviteText(m),
    previewLine: `invite to ${m.workspaceName}, expires in ${ttlText(m.ttlMinutes)}`,
    link: m.link,
  });
}

// Self-serve signup confirmation. Mints the workspace only after the link is
// clicked, so this is the verification gate for /signup. Uses the friendly From
// (this is the first email a new admin gets, and the verify link is the action).
export type SignupVerify = {
  to: string;
  link: string;
  ttlMinutes: number;
  workspaceName: string;
};

// Returns whether the provider accepted the send, so signup can say it failed
// instead of "Check your email".
export async function sendSignupVerify(m: SignupVerify): Promise<boolean> {
  const result = await deliver("signup-verify", {
    to: m.to,
    subject: `Confirm your email · ${m.workspaceName}`,
    html: renderSignupVerifyHtml({ workspaceName: m.workspaceName, link: m.link, ttlMinutes: m.ttlMinutes }),
    text: renderSignupVerifyText({ workspaceName: m.workspaceName, link: m.link, ttlMinutes: m.ttlMinutes }),
    previewLine: `confirm to create ${m.workspaceName}, expires in ${ttlText(m.ttlMinutes)}`,
    link: m.link,
  });
  return result.ok;
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
  /** Hosted read-only copy of the thread; the link when there's no Product URL. */
  viewUrl?: string | null;
  /** When set, used as Reply-To so the customer can reply via email. */
  inboundReplyAddress?: string | null;
  /** One-click unsubscribe link (per-customer token). Omitted ⇒ no footer link. */
  unsubscribeUrl?: string | null;
  /** The workspace's Branding dot color, shown beside its name. */
  accent?: string | null;
};

// Returns whether a real provider accepted the send, so callers can record the
// delivery in the customer_notifications loop ledger. The stdout provider still
// prints the email (dev) but never counts: nothing reached the customer.
export async function sendReplyNotification(m: ReplyNotification): Promise<boolean> {
  const { from } = selectProvider();
  // With inbound wired, Reply-To is the signed reply address, so the customer's
  // answer lands back on the thread (and the email says they can reply).
  const vars = { ...m, threadUrl: buildThreadUrl(m.productUrl, m.itemShortId), replyByEmail: !!m.inboundReplyAddress };

  const result = await deliver("reply-notification", {
    to: m.to,
    from: customerFrom(m.workspaceName, m.inboundReplyAddress ? from : noreplyFrom(from)),
    ...(m.inboundReplyAddress ? { replyTo: m.inboundReplyAddress } : {}),
    subject: `${m.vendorName} replied: ${m.itemTitle}`,
    html: renderReplyNotificationHtml(vars),
    text: renderReplyNotificationText(vars),
    headers: customerHeaders(from, m.workspaceName, `item:${m.itemShortId}`, m.unsubscribeUrl),
    previewLine: `${m.vendorName} on ${m.itemShortId}`,
    link: vars.threadUrl ?? m.viewUrl ?? undefined,
  });
  return result.ok && emailConfigured();
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
  /** Hosted read-only copy of the thread; the link when there's no Product URL. */
  viewUrl?: string | null;
  inboundReplyAddress?: string | null;
  unsubscribeUrl?: string | null;
  /** The workspace's Branding dot color, shown beside its name. */
  accent?: string | null;
};

// Returns whether a real provider accepted the send; never true for stdout
// (see sendReplyNotification). The subject leads with the outcome.
export async function sendStatusChangeNotification(m: StatusChangeNotification): Promise<boolean> {
  const { from } = selectProvider();
  const vars = { ...m, threadUrl: buildThreadUrl(m.productUrl, m.itemShortId), replyByEmail: !!m.inboundReplyAddress };

  const result = await deliver("status-change", {
    to: m.to,
    from: customerFrom(m.workspaceName, m.inboundReplyAddress ? from : noreplyFrom(from)),
    ...(m.inboundReplyAddress ? { replyTo: m.inboundReplyAddress } : {}),
    subject: `${statusLabel(m.toStatus)}: ${m.itemTitle}`,
    html: renderStatusChangeHtml(vars),
    text: renderStatusChangeText(vars),
    headers: customerHeaders(from, m.workspaceName, `item:${m.itemShortId}`, m.unsubscribeUrl),
    previewLine: `${m.fromStatus ?? "—"} → ${m.toStatus}`,
    link: vars.threadUrl ?? m.viewUrl ?? undefined,
  });
  return result.ok && emailConfigured();
}

// ─── Customer-reply notification (to vendor) ─────────────────
// Fires when a customer replies via the widget or via inbound email.
// Goes to the assignee, or the admins when it's unassigned or the assignee
// won't get it (lib/vendor-notify.ts picks who, and Slack or email).

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
  const { from } = selectProvider();
  const subject = `${m.customerName} (${m.accountName}) replied · ${m.itemShortId} ${m.itemTitle}`;
  // Vendor-facing notifications keep the friendly From (not noreply) since
  // we DO want the vendor's mail client to thread these as conversation.
  await deliver("customer-reply", {
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
}

// ─── Mention notification (to a tagged teammate) ─────────────
export type MentionNotification = {
  to: string;
  workspaceName: string;
  byName: string;
  itemShortId: string;
  itemTitle: string;
  noteBody: string;
  dashboardThreadUrl?: string | null;
};

export async function sendMentionNotification(m: MentionNotification): Promise<void> {
  const { from } = selectProvider();
  await deliver("mention", {
    to: m.to,
    from, // vendor-facing — friendly From so it threads as conversation
    subject: `${m.byName} mentioned you · ${m.itemShortId} ${m.itemTitle}`,
    html: renderMentionHtml(m),
    text: renderMentionText(m),
    previewLine: `${m.byName} mentioned you on ${m.itemShortId}`,
    link: m.dashboardThreadUrl ?? undefined,
  });
}

// ─── Vendor nudges: new submission, assignment, engineering done ─────
// To a teammate, from the friendly From like the mention email. The headline
// is the same sentence the Slack DM carries (lib/vendor-notify.ts). True only
// when a real provider accepted it; the stdout provider prints it and says no.
export type VendorNudge = {
  to: string;
  workspaceName: string;
  subject: string;
  /** What happened, as a sentence: "Linear marked FB-12 done. Tell the customer." */
  headline: string;
  itemShortId: string;
  itemTitle: string;
  accountName?: string | null;
  /** The customer's own words, quoted under the headline (new submissions). */
  body?: string | null;
  dashboardThreadUrl?: string | null;
};

export async function sendVendorNudge(m: VendorNudge): Promise<boolean> {
  const { from } = selectProvider();
  const result = await deliver("vendor-nudge", {
    to: m.to,
    from,
    subject: m.subject,
    html: renderVendorNudgeHtml(m),
    text: renderVendorNudgeText(m),
    previewLine: m.headline,
    link: m.dashboardThreadUrl ?? undefined,
  });
  return result.ok && emailConfigured();
}

// ─── Digest (daily or weekly, to one teammate) ───────────────
// Sent by the digest cron (app/api/v1/internal/digest). True only when a real
// provider accepted it, which is when the member's digest watermark moves.
export type Digest = DigestVars & { to: string; subject: string };

export async function sendDigest(m: Digest): Promise<boolean> {
  const { from } = selectProvider();
  const result = await deliver("digest", {
    to: m.to,
    from,
    subject: m.subject,
    html: renderDigestHtml(m),
    text: renderDigestText(m),
    previewLine: m.subject,
    link: m.inboxUrl ?? undefined,
  });
  return result.ok && emailConfigured();
}

// ─── Dunning (payment failed) ────────────────────────────────
// Fires from the Stripe webhook on invoice.payment_failed, once per admin.
// noreply From — it's a transactional billing notice, not a conversation.

export type DunningNotification = {
  to: string;
  workspaceName: string;
  billingUrl?: string | null;
};

// ─── New-signup notification (to the operator) ───────────────
// Sent to CRUMB_OPS_EMAIL when someone completes self-serve signup. noreply
// From — it's an internal ops notice, not a conversation. Best-effort: the
// caller swallows failures so a notify hiccup never breaks signup.

export type SignupNotification = {
  to: string;
  workspaceName: string;
  adminName: string;
  adminEmail: string;
  slug: string;
  dashboardUrl?: string | null;
};

export async function sendSignupNotification(m: SignupNotification): Promise<void> {
  const { from } = selectProvider();
  await deliver("signup-notification", {
    to: m.to,
    from: noreplyFrom(from),
    subject: `New signup · ${m.workspaceName}`,
    html: renderSignupNotificationHtml(m),
    text: renderSignupNotificationText(m),
    previewLine: `${m.adminName} <${m.adminEmail}> created ${m.workspaceName}`,
    link: m.dashboardUrl ?? undefined,
  });
}

// ─── In-app support request (to the operator) ────────────────
// Sent when a teammate uses Help → Contact. noreply From (it's an internal
// notice), but Reply-To is the requesting user so the operator can reply to
// them directly. Returns the SendResult so the action can surface success.
export type SupportRequest = {
  to: string;
  workspaceName: string;
  fromUserName: string;
  fromUserEmail: string;
  subject: string;
  message: string;
};

export async function sendSupportRequest(m: SupportRequest): Promise<SendResult> {
  const { from } = selectProvider();
  return deliver("support-request", {
    to: m.to,
    from: noreplyFrom(from),
    replyTo: m.fromUserEmail,
    subject: `Support · ${m.workspaceName} · ${m.subject}`,
    html: renderSupportRequestHtml(m),
    text: renderSupportRequestText(m),
    previewLine: `${m.fromUserName} <${m.fromUserEmail}>: ${m.subject}`,
  });
}

export async function sendDunningNotification(m: DunningNotification): Promise<void> {
  const { from } = selectProvider();
  await deliver("dunning", {
    to: m.to,
    from: noreplyFrom(from),
    subject: `Payment failed · ${m.workspaceName}`,
    html: renderDunningHtml({ workspaceName: m.workspaceName, billingUrl: m.billingUrl }),
    text: renderDunningText({ workspaceName: m.workspaceName, billingUrl: m.billingUrl }),
    previewLine: "Update your payment method to keep paid features",
    link: m.billingUrl ?? undefined,
  });
}

// ─── Integration disconnected (to workspace admins) ──────────
// Sent once when Crumb drops an integration on its own (lib/integrations/
// revoke.ts): which one, what stopped working, and a Reconnect link. noreply
// From, like dunning: a notice, not a conversation.

export type IntegrationDisconnected = {
  to: string;
  workspaceName: string;
  /** Display name, e.g. "Slack". */
  provider: string;
  /** One sentence on what stopped working. */
  impact: string;
  /** Settings → Integrations on the app origin; null without CRUMB_APP_URL. */
  reconnectUrl: string | null;
};

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function sendIntegrationDisconnected(m: IntegrationDisconnected): Promise<void> {
  const { from } = selectProvider();
  const lead = `Crumb lost access to ${m.provider} for ${m.workspaceName}, so it disconnected the integration. ${m.impact}`;
  const howTo = "Open Crumb and go to Settings, then Integrations, to reconnect.";
  const ws = escHtml(m.workspaceName);
  const action = m.reconnectUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
              <tr><td style="border-radius:8px;background:#1C1815">
                <a href="${escHtml(m.reconnectUrl)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:500;color:#FBF7F0;text-decoration:none;border-radius:8px">Reconnect ${escHtml(m.provider)}</a>
              </td></tr>
            </table>`
    : `<p style="margin:0 0 24px;font-size:14px;color:#4A2E1F">${escHtml(howTo)}</p>`;
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">
          <tr><td style="padding:0 8px 24px">
            <div style="font-weight:600;font-size:18px;letter-spacing:-0.01em">Crumb</div>
            <div style="font-size:12px;color:#6B5C50">Integrations · ${ws}</div>
          </td></tr>
          <tr><td style="padding:0 8px">
            <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.01em">${escHtml(m.provider)} was disconnected</h1>
            <p style="margin:0 0 16px;font-size:14px;color:#4A2E1F">${escHtml(lead)}</p>
            ${action}
          </td></tr>
          <tr><td style="padding:32px 8px 0;border-top:1px solid rgba(28,24,21,0.08)">
            <p style="margin:24px 0 0;font-size:11px;color:#8A7C70">You're receiving this as an admin of ${ws} on Crumb.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  const text = `${m.provider} was disconnected

${lead}

${m.reconnectUrl ? `Reconnect ${m.provider}: ${m.reconnectUrl}` : howTo}`;

  await deliver("integration-disconnected", {
    to: m.to,
    from: noreplyFrom(from),
    subject: `${m.provider} disconnected from ${m.workspaceName}`,
    html,
    text,
    previewLine: `${m.provider} disconnected; reconnect in Settings, Integrations`,
    link: m.reconnectUrl ?? undefined,
  });
}

// ─── Roadmap update (to a following customer) ────────────────
export type RoadmapUpdateNotification = {
  to: string;
  workspaceName: string;
  initiativeName: string;
  change: string;
  productUrl?: string | null;
  unsubscribeUrl?: string | null;
  /** The workspace's Branding dot color, shown beside its name. */
  accent?: string | null;
};

// The subject leads with the move ("Moved to Now: Dark mode").
export async function sendRoadmapUpdateNotification(m: RoadmapUpdateNotification): Promise<void> {
  const { from } = selectProvider();
  await deliver("roadmap-update", {
    to: m.to,
    from: customerFrom(m.workspaceName, noreplyFrom(from)),
    subject: `${m.change.charAt(0).toUpperCase()}${m.change.slice(1)}: ${m.initiativeName}`,
    html: renderRoadmapUpdateHtml(m),
    text: renderRoadmapUpdateText(m),
    headers: customerHeaders(from, m.workspaceName, `initiative:${m.initiativeName}`, m.unsubscribeUrl),
    previewLine: m.change,
    link: m.productUrl ?? undefined,
  });
}

// ─── Shipped announcement (published changelog entry) ────────
// To everyone who asked for the initiative or follows it; `reason` picks the
// footer line. Threads with that initiative's roadmap updates, so it keys on
// the initiative's name, not the entry's (editable) title.
export type ShippedAnnouncement = {
  to: string;
  workspaceName: string;
  initiativeName: string;
  title: string;
  body: string;
  reason: "asked" | "follow";
  productUrl?: string | null;
  unsubscribeUrl?: string | null;
  /** The workspace's Branding dot color, shown beside its name. */
  accent?: string | null;
};

// True only when a real provider accepted it (never stdout), like the other
// customer emails.
export async function sendShippedAnnouncement(m: ShippedAnnouncement): Promise<boolean> {
  const { from } = selectProvider();
  const result = await deliver("shipped-announcement", {
    to: m.to,
    from: customerFrom(m.workspaceName, noreplyFrom(from)),
    subject: `Shipped: ${m.title}`,
    html: renderShippedAnnouncementHtml(m),
    text: renderShippedAnnouncementText(m),
    headers: customerHeaders(from, m.workspaceName, `initiative:${m.initiativeName}`, m.unsubscribeUrl),
    previewLine: `${m.workspaceName} shipped ${m.title}`,
    link: m.productUrl ?? undefined,
  });
  return result.ok && emailConfigured();
}

// ─── Public follows (an address typed on the public pages) ───
// The confirmation the Follow and "Email me updates" forms send, and the
// updates a confirmed follower gets (lib/public-follows). From the vendor via
// Crumb on noreply@, like the other customer emails.

export type PublicFollowConfirm = PublicFollowConfirmVars & { to: string };

export async function sendPublicFollowConfirm(m: PublicFollowConfirm): Promise<void> {
  const { from } = selectProvider();
  await deliver("public-follow-confirm", {
    to: m.to,
    from: customerFrom(m.workspaceName, noreplyFrom(from)),
    subject: `Confirm updates from ${m.workspaceName}`,
    html: renderPublicFollowConfirmHtml(m),
    text: renderPublicFollowConfirmText(m),
    previewLine: `confirm a public follow, expires in ${ttlText(m.ttlDays * 1440)}`,
    link: m.link,
  });
}

export type PublicFollowUpdate = PublicFollowUpdateVars & { to: string };

// A move leads with the move ("Moved to Now: Dark mode"), as the customer
// roadmap email does. True only when a real provider accepted it.
export async function sendPublicFollowUpdate(m: PublicFollowUpdate): Promise<boolean> {
  const { from } = selectProvider();
  const move = m.kind === "roadmap_move";
  const subject = move
    ? `${m.summary.charAt(0).toUpperCase()}${m.summary.slice(1)}: ${m.title}`
    : `New from ${m.workspaceName}: ${m.title}`;
  const result = await deliver("public-follow-update", {
    to: m.to,
    from: customerFrom(m.workspaceName, noreplyFrom(from)),
    subject,
    html: renderPublicFollowUpdateHtml(m),
    text: renderPublicFollowUpdateText(m),
    headers: customerHeaders(from, m.workspaceName, `${move ? "initiative" : "changelog"}:${m.title}`, m.unsubscribeUrl),
    previewLine: subject,
    link: m.url ?? undefined,
  });
  return result.ok && emailConfigured();
}
