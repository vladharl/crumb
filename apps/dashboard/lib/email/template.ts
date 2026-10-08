import "server-only";
import { statusLabel } from "@crumb/ui";
import { originFromHeaders } from "@/lib/origin";

export type MagicLinkVars = {
  workspaceName?: string;
  link: string;
  ttlMinutes: number;
};

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

// Crumb's mark as text: Gmail and Outlook drop inline SVG.
const EMBER_MARK = `<span style="color:#E27D3A;font-size:22px;line-height:1">&#9679;</span>`;

function ttlPhrase(min: number): string {
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  if (min < 60 * 24) {
    const h = Math.round(min / 60);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(min / (60 * 24));
  return `${d} day${d === 1 ? "" : "s"}`;
}

export function renderMagicLinkHtml(v: MagicLinkVars): string {
  const workspace = v.workspaceName ? `· ${escapeHtml(v.workspaceName)}` : "";
  const ttl = escapeHtml(ttlPhrase(v.ttlMinutes));
  const link = escapeHtml(v.link);
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">
          <tr><td style="padding:0 8px 24px">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:10px">${EMBER_MARK}</td>
                <td>
                  <div style="font-weight:600;font-size:18px;letter-spacing:-0.01em">Crumb</div>
                  <div style="font-size:12px;color:#6B5C50">Follow the trail${workspace ? ` ${workspace}` : "."}</div>
                </td>
              </tr>
            </table>
          </td></tr>
          <tr><td style="padding:0 8px">
            <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.01em">Sign in to Crumb</h1>
            <p style="margin:0 0 24px;font-size:14px;color:#4A2E1F">
              Click the button below to sign in. The link expires in ${ttl} and only works once.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
              <tr><td style="border-radius:8px;background:#1C1815">
                <a href="${link}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:500;color:#FBF7F0;text-decoration:none;border-radius:8px">
                  Sign in
                </a>
              </td></tr>
            </table>
            <p style="margin:0 0 8px;font-size:12px;color:#6B5C50">
              Or copy and paste this URL into your browser:
            </p>
            <p style="margin:0;font-size:12px;color:#4A2E1F;word-break:break-all">
              <a href="${link}" style="color:#4A2E1F">${link}</a>
            </p>
          </td></tr>
          <tr><td style="padding:32px 8px 0;border-top:1px solid rgba(28,24,21,0.08);margin-top:32px">
            <p style="margin:24px 0 0;font-size:11px;color:#8A7C70">
              Didn't request this? You can safely ignore the email. No account changes happen without clicking.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function renderMagicLinkText(v: MagicLinkVars): string {
  const ws = v.workspaceName ? ` (${v.workspaceName})` : "";
  return `Sign in to Crumb${ws}

Click the link below to sign in. It expires in ${ttlPhrase(v.ttlMinutes)} and only works once.

${v.link}

Didn't request this? You can safely ignore this email.`;
}

// ─── Self-serve signup verification ──────────────────────────
// Sent when a visitor signs up at /signup. Confirms they own the email before
// the workspace is created (clicking the link mints it + signs them in).

export type SignupVerifyVars = {
  workspaceName: string;
  link: string;
  ttlMinutes: number;
};

export function renderSignupVerifyHtml(v: SignupVerifyVars): string {
  const workspace = escapeHtml(v.workspaceName);
  const ttl = escapeHtml(ttlPhrase(v.ttlMinutes));
  const link = escapeHtml(v.link);
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">
          <tr><td style="padding:0 8px 24px">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:10px">${EMBER_MARK}</td>
                <td>
                  <div style="font-weight:600;font-size:18px;letter-spacing:-0.01em">Crumb</div>
                  <div style="font-size:12px;color:#6B5C50">Follow the trail.</div>
                </td>
              </tr>
            </table>
          </td></tr>
          <tr><td style="padding:0 8px">
            <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.01em">Confirm your email</h1>
            <p style="margin:0 0 24px;font-size:14px;color:#4A2E1F">
              Click below to finish creating your <strong>${workspace}</strong> workspace and sign in. The link expires in ${ttl} and only works once.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
              <tr><td style="border-radius:8px;background:#1C1815">
                <a href="${link}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:500;color:#FBF7F0;text-decoration:none;border-radius:8px">
                  Create workspace
                </a>
              </td></tr>
            </table>
            <p style="margin:0 0 8px;font-size:12px;color:#6B5C50">
              Or copy and paste this URL into your browser:
            </p>
            <p style="margin:0;font-size:12px;color:#4A2E1F;word-break:break-all">
              <a href="${link}" style="color:#4A2E1F">${link}</a>
            </p>
          </td></tr>
          <tr><td style="padding:32px 8px 0;border-top:1px solid rgba(28,24,21,0.08);margin-top:32px">
            <p style="margin:24px 0 0;font-size:11px;color:#8A7C70">
              Didn't sign up for Crumb? You can safely ignore this email. No workspace is created without clicking.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function renderSignupVerifyText(v: SignupVerifyVars): string {
  return `Confirm your email

Click the link below to finish creating your ${v.workspaceName} workspace and sign in. It expires in ${ttlPhrase(v.ttlMinutes)} and only works once.

${v.link}

Didn't sign up for Crumb? You can safely ignore this email.`;
}

// ─── Team invite ────────────────────────────────────────────
// A teammate added you to their workspace. The button is a regular magic link
// (it signs you in), so the copy says so and when it runs out.

export type InviteVars = {
  workspaceName: string;
  inviterName: string;
  link: string;
  ttlMinutes: number;
};

const invitePitch = (ws: string) =>
  `Crumb is where ${ws} keeps customer feedback, decides what to build, and tells customers how it turned out.`;
const inviteExpiry = (min: number) => `The button signs you in. It works once and expires in ${ttlPhrase(min)}.`;

export function renderInviteHtml(v: InviteVars): string {
  const link = escapeHtml(v.link);
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"></head>
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">
          <tr><td style="padding:0 8px 24px;font-weight:600;font-size:18px;letter-spacing:-0.01em">Crumb</td></tr>
          <tr><td style="padding:0 8px">
            <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.01em">${escapeHtml(`${v.inviterName} invited you to ${v.workspaceName}`)}</h1>
            <p style="margin:0 0 24px;font-size:14px;color:#4A2E1F">${escapeHtml(invitePitch(v.workspaceName))}</p>
            ${buttonHtml(v.link, `Join ${v.workspaceName}`)}
            <p style="margin:16px 0 8px;font-size:12px;color:#6B5C50">${escapeHtml(inviteExpiry(v.ttlMinutes))} Or paste this into your browser:</p>
            <p style="margin:0;font-size:12px;color:#4A2E1F;word-break:break-all"><a href="${link}" style="color:#4A2E1F">${link}</a></p>
          </td></tr>
          <tr><td style="padding:32px 8px 0">
            <p style="margin:0;padding-top:20px;border-top:1px solid rgba(28,24,21,0.08);font-size:11px;color:#8A7C70">Not expecting this? You can ignore it. Nothing happens until you click.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function renderInviteText(v: InviteVars): string {
  return [
    `${v.inviterName} invited you to ${v.workspaceName} on Crumb`,
    invitePitch(v.workspaceName),
    `Join ${v.workspaceName}: ${v.link}`,
    inviteExpiry(v.ttlMinutes),
    "Not expecting this? You can ignore it. Nothing happens until you click.",
  ].join("\n\n");
}

// ─── Customer-facing shell ───────────────────────────────────
// What a vendor's customer receives comes from the vendor: their name leads,
// with their Branding dot color as a text mark when the sender passes it (Gmail
// and Outlook drop inline SVG). Crumb appears once, in the footer, linked to
// this deployment's CRUMB_APP_URL, or unlinked when that's unset.

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// Footer fragment: appends a one-click unsubscribe link to the standard
// "you're getting this because…" line. Empty when no URL is provided.
function unsubLinkHtml(url?: string | null): string {
  return url
    ? ` · <a href="${escapeHtml(url)}" style="color:#8A7C70;text-decoration:underline">Unsubscribe</a>`
    : "";
}
function unsubLineText(url?: string | null): string {
  return url ? `\n\nUnsubscribe: ${url}` : "";
}

// Never cut text short without a link to the whole of it.
function truncate(s: string, link?: string | null, max = 600): string {
  if (!link || s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function paragraphsToHtml(body: string): string {
  // Naive: split on double-newlines into <p>, escape, preserve single newlines as <br>.
  return body
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#1C1815">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// No request here, so this is CRUMB_APP_URL or null (never a guessed host).
const appOrigin = () => originFromHeaders(new Headers());

function buttonHtml(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#4A2E1F">
              <a href="${escapeHtml(url)}" style="display:inline-block;padding:9px 18px;font-size:13px;font-weight:500;color:#FBF7F0;text-decoration:none;border-radius:8px">${escapeHtml(label)}</a>
            </td></tr></table>`;
}

function noteHtml(text: string, top = 0): string {
  return `<p style="margin:${top}px 0 0;font-size:13px;color:#4A2E1F">${escapeHtml(text)}</p>`;
}

// The vendor's words (a reply, a reason) on a paper card.
function cardHtml(body: string): string {
  return `
          <tr><td style="padding:0 8px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FDFAF4;border:1px solid rgba(74,46,31,0.15);border-radius:10px">
              <tr><td style="padding:16px 18px 4px">${paragraphsToHtml(body)}</td></tr>
            </table>
          </td></tr>`;
}

const sentFor = {
  item: (ws: string) => `You're getting this because you sent feedback to ${ws}.`,
  asked: (ws: string) => `You're getting this because you asked ${ws} for this.`,
  follow: (ws: string) => `You're getting this because you follow this on ${ws}'s roadmap.`,
};

function customerShell(v: {
  workspaceName: string;
  accent?: string | null;
  rows: string;
  /** Why they got it, plain text (escaped here). */
  reason: string;
  unsubscribeUrl?: string | null;
}): string {
  const mark = v.accent && HEX_COLOR.test(v.accent) ? `<span style="color:${v.accent};margin-right:8px">&#9679;</span>` : "";
  const app = appOrigin();
  const via = app ? `Sent via <a href="${escapeHtml(app)}" style="color:#8A7C70">Crumb</a>.` : "Sent via Crumb.";
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"></head>
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">
          <tr><td style="padding:0 8px 20px;font-size:17px;font-weight:600;letter-spacing:-0.01em">${mark}${escapeHtml(v.workspaceName)}</td></tr>
${v.rows}
          <tr><td style="padding:32px 8px 0">
            <p style="margin:0;padding-top:20px;border-top:1px solid rgba(28,24,21,0.08);font-size:11px;color:#8A7C70">${escapeHtml(v.reason)} ${via}${unsubLinkHtml(v.unsubscribeUrl)}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function customerFooterText(reason: string, unsubscribeUrl?: string | null): string {
  const app = appOrigin();
  return `${reason} ${app ? `Sent via Crumb: ${app}` : "Sent via Crumb."}${unsubLineText(unsubscribeUrl)}`;
}

// Where the customer goes from an item email. Never a dead end: the product's
// Feedback tab when Branding has a Product URL, else the hosted read-only copy
// of the thread (viewUrl, app/t), else directions to the Feedback tab; plus
// reply-by-email when inbound mail is wired.
type NextStep = { workspaceName: string; threadUrl?: string | null; viewUrl?: string | null; replyByEmail?: boolean };

function nextStepHtml(v: NextStep): string {
  const go = v.threadUrl
    ? buttonHtml(v.threadUrl, "Open the Feedback tab")
    : v.viewUrl
      ? buttonHtml(v.viewUrl, "View the conversation")
      : noteHtml(`Open ${v.workspaceName}'s Feedback tab to read and reply.`);
  return `
          <tr><td style="padding:24px 8px 0">
            ${go}${v.replyByEmail ? noteHtml("Reply to this email to answer.", 12) : ""}
          </td></tr>`;
}

function nextStepText(v: NextStep): string {
  const go = v.threadUrl
    ? `Open the Feedback tab: ${v.threadUrl}`
    : v.viewUrl
      ? `View the conversation: ${v.viewUrl}`
      : `Open ${v.workspaceName}'s Feedback tab to read and reply.`;
  return v.replyByEmail ? `${go}\nReply to this email to answer.` : go;
}

// ─── Reply notification ─────────────────────────────────────
// Sent to the customer when a vendor (PM) replies on a thread. Carries the
// whole reply, so the email reads complete without opening anything.

export type ReplyNotificationVars = NextStep & {
  workspaceName: string;     // e.g. "Southbeam"
  vendorName: string;        // e.g. "Lina Rivers"
  itemTitle: string;
  replyBody: string;
  /** Brief status (e.g. "In review") — optional. */
  statusLabel?: string;
  /** One-click unsubscribe link (per-customer token). Adds a footer link. */
  unsubscribeUrl?: string | null;
  /** The workspace's Branding dot color (#RRGGBB). */
  accent?: string | null;
};

export function renderReplyNotificationHtml(v: ReplyNotificationVars): string {
  const status = v.statusLabel ? `<span style="margin-left:8px;padding:2px 8px;border:1px solid rgba(28,24,21,0.18);border-radius:999px;font-size:11px;color:#4A2E1F">${escapeHtml(v.statusLabel)}</span>` : "";
  return customerShell({
    workspaceName: v.workspaceName,
    accent: v.accent,
    reason: sentFor.item(v.workspaceName),
    unsubscribeUrl: v.unsubscribeUrl,
    rows: `
          <tr><td style="padding:0 8px 16px">
            <h1 style="margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:-0.01em">${escapeHtml(v.vendorName)} replied to your feedback</h1>
            <p style="margin:0;font-size:14px;color:#4A2E1F">On <strong style="font-weight:500">${escapeHtml(v.itemTitle)}</strong>${status}</p>
          </td></tr>${v.replyBody.trim() ? cardHtml(v.replyBody) : ""}${nextStepHtml(v)}`,
  });
}

export function renderReplyNotificationText(v: ReplyNotificationVars): string {
  const status = v.statusLabel ? ` (${v.statusLabel})` : "";
  return [
    `${v.vendorName} replied to your feedback on "${v.itemTitle}"${status}${v.replyBody.trim() ? ":" : "."}`,
    v.replyBody.trim(),
    nextStepText(v),
    customerFooterText(sentFor.item(v.workspaceName), v.unsubscribeUrl),
  ].filter(Boolean).join("\n\n");
}

// ─── Status change notification ──────────────────────────────
// Sent to the customer when the PM moves an item to a new status. The outcome
// leads (subject and heading); the blurbs state what the status means and
// never promise anything the vendor didn't say.

export type StatusChangeVars = NextStep & {
  workspaceName: string;
  vendorName: string;
  itemTitle: string;
  fromStatus: string | null;
  toStatus: string;
  reason?: string | null;
  /** One-click unsubscribe link (per-customer token). Adds a footer link. */
  unsubscribeUrl?: string | null;
  /** The workspace's Branding dot color (#RRGGBB). */
  accent?: string | null;
};

const STATUS_BLURBS: Record<string, string> = {
  review:    "Nothing is decided yet.",
  planned:   "Work hasn't started yet.",
  progress:  "Work on it has started.",
  shipped:   "It's live now.",
  declined:  "The team decided not to take this on.",
  deferred:  "It's on hold, with no decision yet.",
  duplicate: "It's tracked under another request.",
};

function statusLine(v: StatusChangeVars): string {
  const from = v.fromStatus ? ` from ${statusLabel(v.fromStatus)}` : "";
  return `${v.vendorName} moved this${from} to ${statusLabel(v.toStatus)}. ${STATUS_BLURBS[v.toStatus] ?? ""}`.trim();
}

export function renderStatusChangeHtml(v: StatusChangeVars): string {
  return customerShell({
    workspaceName: v.workspaceName,
    accent: v.accent,
    reason: sentFor.item(v.workspaceName),
    unsubscribeUrl: v.unsubscribeUrl,
    rows: `
          <tr><td style="padding:0 8px 16px">
            <h1 style="margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:-0.01em">${escapeHtml(`${statusLabel(v.toStatus)}: ${v.itemTitle}`)}</h1>
            <p style="margin:0;font-size:14px;color:#4A2E1F">${escapeHtml(statusLine(v))}</p>
          </td></tr>${v.reason?.trim() ? cardHtml(v.reason) : ""}${nextStepHtml(v)}`,
  });
}

export function renderStatusChangeText(v: StatusChangeVars): string {
  return [
    `${statusLabel(v.toStatus)}: ${v.itemTitle}`,
    statusLine(v),
    v.reason?.trim() ?? "",
    nextStepText(v),
    customerFooterText(sentFor.item(v.workspaceName), v.unsubscribeUrl),
  ].filter(Boolean).join("\n\n");
}

// ─── Mention notification (to a tagged teammate) ────────────
// Fired when a teammate @-mentions you in an internal note. Vendor-internal,
// points back at the dashboard thread.
export type MentionVars = {
  workspaceName: string;
  byName: string;            // who mentioned you
  itemShortId: string;
  itemTitle: string;
  noteBody: string;
  dashboardThreadUrl?: string | null;
};

export function renderMentionHtml(v: MentionVars): string {
  const ws = escapeHtml(v.workspaceName);
  const by = escapeHtml(v.byName);
  const shortId = escapeHtml(v.itemShortId);
  const title = escapeHtml(v.itemTitle);
  const body = paragraphsToHtml(truncate(v.noteBody, v.dashboardThreadUrl));
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">
          <tr><td style="padding:0 8px 8px">
            <div style="font-size:11px;color:#6B5C50;font-family:ui-monospace,JetBrains Mono,Menlo,monospace">${ws} · ${shortId}</div>
            <h1 style="margin:6px 0 6px;font-size:18px;font-weight:600;letter-spacing:-0.01em">${by} mentioned you</h1>
            <p style="margin:0 0 16px;font-size:14px;color:#4A2E1F">in an internal note on <strong style="font-weight:500">${title}</strong>:</p>
          </td></tr>
          <tr><td style="padding:0 8px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1C1815;border-radius:10px">
              <tr><td style="padding:16px 18px;color:#FBF7F0">
                ${body.replace(/color:#1C1815/g, "color:#FBF7F0")}
              </td></tr>
            </table>
          </td></tr>
          ${v.dashboardThreadUrl ? `
          <tr><td style="padding:24px 8px 0">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#4A2E1F">
              <a href="${escapeHtml(v.dashboardThreadUrl)}" style="display:inline-block;padding:9px 18px;font-size:13px;font-weight:500;color:#FBF7F0;text-decoration:none;border-radius:8px">Open thread →</a>
            </td></tr></table>
          </td></tr>` : ""}
          <tr><td style="padding:32px 8px 0;border-top:1px solid rgba(28,24,21,0.08)">
            <p style="margin:24px 0 0;font-size:11px;color:#8A7C70">You're getting this because a teammate mentioned you on ${ws}. Manage notifications in Settings.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function renderMentionText(v: MentionVars): string {
  return `${v.byName} mentioned you in an internal note on Crumb.

${v.workspaceName} · ${v.itemShortId}
${v.itemTitle}

---
${truncate(v.noteBody, v.dashboardThreadUrl)}
---

${v.dashboardThreadUrl ? `Open thread: ${v.dashboardThreadUrl}` : `Open Crumb to read the note.`}`;
}

// ─── Customer-reply notification (to vendor) ─────────────────
// Fired when a customer replies via the widget or via inbound email. Goes
// to the assignee (or all admins on an unassigned item). Different from
// the vendor→customer reply email in framing — this one says "someone's
// waiting on you" and points back to the dashboard thread.

export type CustomerReplyNotificationVars = {
  workspaceName: string;        // vendor's own workspace name
  customerName: string;         // who replied (account_user.name)
  accountName: string;          // their account name
  itemShortId: string;
  itemTitle: string;
  replyBody: string;
  /** Dashboard URL to the thread, e.g. https://dashboard.example.com/thread/FB-247. */
  dashboardThreadUrl?: string | null;
};

export function renderCustomerReplyNotificationHtml(v: CustomerReplyNotificationVars): string {
  const ws = escapeHtml(v.workspaceName);
  const customer = escapeHtml(v.customerName);
  const account = escapeHtml(v.accountName);
  const shortId = escapeHtml(v.itemShortId);
  const title = escapeHtml(v.itemTitle);
  const body = paragraphsToHtml(truncate(v.replyBody, v.dashboardThreadUrl));

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">
          <tr><td style="padding:0 8px 20px">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:10px">${EMBER_MARK}</td>
                <td>
                  <div style="font-weight:600;font-size:17px;letter-spacing:-0.01em">${ws}</div>
                  <div style="font-size:11px;color:#6B5C50;font-family:ui-monospace,JetBrains Mono,Menlo,monospace">${shortId} · ${account}</div>
                </td>
              </tr>
            </table>
          </td></tr>

          <tr><td style="padding:0 8px 8px">
            <h1 style="margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:-0.01em">${customer} replied</h1>
            <p style="margin:0 0 20px;font-size:14px;color:#4A2E1F">
              On <strong style="font-weight:500">${title}</strong>:
            </p>
          </td></tr>

          <tr><td style="padding:0 8px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1C1815;border-radius:10px">
              <tr><td style="padding:16px 18px;color:#FBF7F0">
                ${body.replace(/color:#1C1815/g, "color:#FBF7F0")}
              </td></tr>
            </table>
          </td></tr>

          ${v.dashboardThreadUrl ? `
          <tr><td style="padding:24px 8px 0">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr><td style="border-radius:8px;background:#4A2E1F">
                <a href="${escapeHtml(v.dashboardThreadUrl)}" style="display:inline-block;padding:9px 18px;font-size:13px;font-weight:500;color:#FBF7F0;text-decoration:none;border-radius:8px">
                  Open in Crumb →
                </a>
              </td></tr>
            </table>
          </td></tr>` : ""}

          <tr><td style="padding:32px 8px 0;border-top:1px solid rgba(28,24,21,0.08);margin-top:32px">
            <p style="margin:24px 0 0;font-size:11px;color:#8A7C70">
              You're on the team for ${ws}. Change what nudges you in Crumb's Notifications settings.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function renderCustomerReplyNotificationText(v: CustomerReplyNotificationVars): string {
  return `${v.customerName} (${v.accountName}) replied on ${v.itemShortId}.

${v.workspaceName} · ${v.itemShortId}
${v.itemTitle}

---
${truncate(v.replyBody, v.dashboardThreadUrl)}
---

${v.dashboardThreadUrl ? `Open in Crumb: ${v.dashboardThreadUrl}` : `Open the thread in your Crumb dashboard to reply.`}`;
}

// ─── Vendor shell (teammate alerts and the digest) ───────────
// The workspace leads, like the customer-reply email, with a mono eyebrow
// under it and one footer line saying why this arrived and how to change it.

export const vendorFooter = (ws: string) => `You're on the team for ${ws}. Change what nudges you in Crumb's Notifications settings.`;

function vendorShell(v: { workspaceName: string; eyebrow: string; rows: string; footer: string }): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"></head>
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">
          <tr><td style="padding:0 8px 20px">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:10px">${EMBER_MARK}</td>
                <td>
                  <div style="font-weight:600;font-size:17px;letter-spacing:-0.01em">${escapeHtml(v.workspaceName)}</div>
                  <div style="font-size:11px;color:#6B5C50;font-family:ui-monospace,JetBrains Mono,Menlo,monospace">${escapeHtml(v.eyebrow)}</div>
                </td>
              </tr>
            </table>
          </td></tr>
${v.rows}
          <tr><td style="padding:32px 8px 0">
            <p style="margin:0;padding-top:20px;border-top:1px solid rgba(28,24,21,0.08);font-size:11px;color:#8A7C70">${escapeHtml(v.footer)}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

// ─── Vendor nudge (new submission, assignment, engineering done) ─────
// One shape for the short teammate alerts: what happened as a sentence, the
// item, the customer's words when there are some, and the way to the thread.

export type VendorNudgeVars = {
  workspaceName: string;
  headline: string;
  itemShortId: string;
  itemTitle: string;
  accountName?: string | null;
  body?: string | null;
  dashboardThreadUrl?: string | null;
};

const nudgeEyebrow = (v: VendorNudgeVars) => v.accountName ? `${v.itemShortId} · ${v.accountName}` : v.itemShortId;

export function renderVendorNudgeHtml(v: VendorNudgeVars): string {
  const body = v.body?.trim() ? truncate(v.body.trim(), v.dashboardThreadUrl) : "";
  return vendorShell({
    workspaceName: v.workspaceName,
    eyebrow: nudgeEyebrow(v),
    footer: vendorFooter(v.workspaceName),
    rows: `
          <tr><td style="padding:0 8px 16px">
            <h1 style="margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:-0.01em">${escapeHtml(v.headline)}</h1>
            <p style="margin:0;font-size:14px;color:#4A2E1F"><strong style="font-weight:500">${escapeHtml(v.itemTitle)}</strong></p>
          </td></tr>${body ? cardHtml(body) : ""}
          <tr><td style="padding:24px 8px 0">
            ${v.dashboardThreadUrl ? buttonHtml(v.dashboardThreadUrl, "Open in Crumb") : noteHtml("Open the thread in Crumb to reply.")}
          </td></tr>`,
  });
}

export function renderVendorNudgeText(v: VendorNudgeVars): string {
  const body = v.body?.trim() ? truncate(v.body.trim(), v.dashboardThreadUrl) : "";
  return [
    v.headline,
    `${nudgeEyebrow(v)}\n${v.itemTitle}`,
    body ? `---\n${body}\n---` : "",
    v.dashboardThreadUrl ? `Open in Crumb: ${v.dashboardThreadUrl}` : "Open the thread in Crumb to reply.",
    vendorFooter(v.workspaceName),
  ].filter(Boolean).join("\n\n");
}

// ─── Digest (daily or weekly) ───────────────────────────────
// A few short lists, each item linking to its thread. Sections arrive already
// chosen and capped; `total` says how many there are in all.

export type DigestLine = { shortId: string; title: string; detail?: string | null; url?: string | null };
export type DigestSection = { heading: string; total: number; lines: DigestLine[] };
export type DigestVars = {
  workspaceName: string;
  heading: string;
  sections: DigestSection[];
  /** The Inbox, for "and N more". */
  inboxUrl?: string | null;
  /** Why this arrives and how to change it. */
  footer: string;
  /** The line under the workspace name: "Digest" unless set (a bulk assignment's list). */
  eyebrow?: string;
};

const moreText = (n: number) => `And ${n} more in the Inbox.`;

export function renderDigestHtml(v: DigestVars): string {
  const sections = v.sections.map(sec => {
    const lines = sec.lines.map(l => {
      const title = l.url
        ? `<a href="${escapeHtml(l.url)}" style="color:#1C1815;text-decoration:underline">${escapeHtml(l.title)}</a>`
        : escapeHtml(l.title);
      const detail = l.detail ? `<span style="color:#6B5C50"> · ${escapeHtml(l.detail)}</span>` : "";
      return `<p style="margin:0 0 6px;font-size:14px"><span style="font-size:12px;color:#6B5C50;font-family:ui-monospace,JetBrains Mono,Menlo,monospace">${escapeHtml(l.shortId)}</span> ${title}${detail}</p>`;
    }).join("");
    const more = sec.total - sec.lines.length;
    const moreHtml = more <= 0 ? ""
      : v.inboxUrl
        ? `<p style="margin:0;font-size:12px;color:#6B5C50">And ${more} more in the <a href="${escapeHtml(v.inboxUrl)}" style="color:#6B5C50">Inbox</a>.</p>`
        : `<p style="margin:0;font-size:12px;color:#6B5C50">${escapeHtml(moreText(more))}</p>`;
    return `
          <tr><td style="padding:20px 8px 0">
            <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#4A2E1F">${escapeHtml(`${sec.heading} (${sec.total})`)}</p>
            ${lines}${moreHtml}
          </td></tr>`;
  }).join("");
  return vendorShell({
    workspaceName: v.workspaceName,
    eyebrow: v.eyebrow ?? "Digest",
    footer: v.footer,
    rows: `
          <tr><td style="padding:0 8px">
            <h1 style="margin:0;font-size:18px;font-weight:600;letter-spacing:-0.01em">${escapeHtml(v.heading)}</h1>
          </td></tr>${sections}`,
  });
}

export function renderDigestText(v: DigestVars): string {
  const sections = v.sections.map(sec => {
    const lines = sec.lines.map(l => `- ${l.shortId} ${l.title}${l.detail ? ` · ${l.detail}` : ""}${l.url ? `\n  ${l.url}` : ""}`);
    const more = sec.total - sec.lines.length;
    if (more > 0) lines.push(v.inboxUrl ? `And ${more} more in the Inbox: ${v.inboxUrl}` : moreText(more));
    return `${sec.heading} (${sec.total})\n${lines.join("\n")}`;
  });
  return [`${v.heading} · ${v.workspaceName}`, ...sections, v.footer].join("\n\n");
}

// ─── Dunning (payment failed) ───────────────────────────────
// Sent to workspace admins when Stripe reports a failed invoice. The CTA
// points at the in-app billing page (which links onward to the Stripe
// portal). Plain, urgent, single action.

export type DunningVars = {
  workspaceName: string;
  /** Dashboard billing URL, e.g. https://dash.example.com/settings/billing */
  billingUrl?: string | null;
};

export function renderDunningHtml(v: DunningVars): string {
  const ws = escapeHtml(v.workspaceName);
  const url = v.billingUrl ? escapeHtml(v.billingUrl) : null;
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">
          <tr><td style="padding:0 8px 24px">
            <div style="font-weight:600;font-size:18px;letter-spacing:-0.01em">Crumb</div>
            <div style="font-size:12px;color:#6B5C50">Billing · ${ws}</div>
          </td></tr>
          <tr><td style="padding:0 8px">
            <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.01em">Your payment didn't go through</h1>
            <p style="margin:0 0 16px;font-size:14px;color:#4A2E1F">
              We couldn't charge the card on file for <strong style="font-weight:500">${ws}</strong>. Paid features stay live during a short grace period. Update your payment method to avoid dropping to the free plan.
            </p>
            ${url ? `
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
              <tr><td style="border-radius:8px;background:#1C1815">
                <a href="${url}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:500;color:#FBF7F0;text-decoration:none;border-radius:8px">
                  Update payment method
                </a>
              </td></tr>
            </table>` : `
            <p style="margin:0 0 24px;font-size:14px;color:#4A2E1F">Open your Crumb dashboard → Settings → Billing to update your card.</p>`}
          </td></tr>
          <tr><td style="padding:32px 8px 0;border-top:1px solid rgba(28,24,21,0.08)">
            <p style="margin:24px 0 0;font-size:11px;color:#8A7C70">
              You're receiving this as an admin of ${ws} on Crumb. <a href="https://crumb.localhostlabs.net" style="color:#8A7C70">crumb.localhostlabs.net</a>
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function renderDunningText(v: DunningVars): string {
  return `Your payment didn't go through

We couldn't charge the card on file for ${v.workspaceName}. Paid features stay live during a short grace period. Update your payment method to avoid dropping to the free plan.

${v.billingUrl ? `Update payment method: ${v.billingUrl}` : "Open your Crumb dashboard → Settings → Billing to update your card."}`;
}

// ─── Roadmap update (to a customer following an initiative) ──
// Fires when a vendor moves a public roadmap item the customer follows.

export type RoadmapUpdateVars = {
  workspaceName: string;
  initiativeName: string;
  change: string; // e.g. "moved to Now"
  productUrl?: string | null;
  unsubscribeUrl?: string | null;
  /** The workspace's Branding dot color (#RRGGBB). */
  accent?: string | null;
};

const roadmapReason = (ws: string) => `${sentFor.follow(ws)} Unfollow it from the Feedback tab.`;

export function renderRoadmapUpdateHtml(v: RoadmapUpdateVars): string {
  return customerShell({
    workspaceName: v.workspaceName,
    accent: v.accent,
    reason: roadmapReason(v.workspaceName),
    unsubscribeUrl: v.unsubscribeUrl,
    rows: `
          <tr><td style="padding:0 8px">
            <h1 style="margin:0 0 12px;font-size:18px;font-weight:600;letter-spacing:-0.01em">A roadmap item you follow was updated</h1>
            <p style="margin:0;font-size:14px;color:#4A2E1F"><strong style="font-weight:600">${escapeHtml(v.initiativeName)}</strong>: ${escapeHtml(v.change)}.</p>
          </td></tr>
          <tr><td style="padding:24px 8px 0">
            ${v.productUrl ? buttonHtml(v.productUrl, "View the roadmap") : noteHtml(`Open ${v.workspaceName}'s Feedback tab to see the roadmap.`)}
          </td></tr>`,
  });
}

export function renderRoadmapUpdateText(v: RoadmapUpdateVars): string {
  return [
    "A roadmap item you follow was updated",
    `${v.initiativeName}: ${v.change}.`,
    v.productUrl ? `View the roadmap: ${v.productUrl}` : `Open ${v.workspaceName}'s Feedback tab to see the roadmap.`,
    customerFooterText(roadmapReason(v.workspaceName), v.unsubscribeUrl),
  ].join("\n\n");
}

// ─── Shipped announcement (published changelog entry) ───────
// The loop's last beat: an initiative shipped and the vendor published the
// news. Goes to everyone who asked (item submitters) and everyone following
// it, so the footer says which one this reader is.

export type ShippedAnnouncementVars = {
  workspaceName: string;
  /** The changelog entry's title (defaults to the initiative's name). */
  title: string;
  /** The vendor's announcement text; may be empty. */
  body: string;
  reason: "asked" | "follow";
  productUrl?: string | null;
  unsubscribeUrl?: string | null;
  /** The workspace's Branding dot color (#RRGGBB). */
  accent?: string | null;
};

const shippedBody = (v: ShippedAnnouncementVars) => v.body.trim() || "It's live now.";

export function renderShippedAnnouncementHtml(v: ShippedAnnouncementVars): string {
  return customerShell({
    workspaceName: v.workspaceName,
    accent: v.accent,
    reason: sentFor[v.reason](v.workspaceName),
    unsubscribeUrl: v.unsubscribeUrl,
    rows: `
          <tr><td style="padding:0 8px">
            <h1 style="margin:0 0 12px;font-size:18px;font-weight:600;letter-spacing:-0.01em">${escapeHtml(`Shipped: ${v.title}`)}</h1>
            ${paragraphsToHtml(shippedBody(v))}
          </td></tr>${v.productUrl ? `
          <tr><td style="padding:12px 8px 0">
            ${buttonHtml(v.productUrl, `Open ${v.workspaceName}`)}
          </td></tr>` : ""}`,
  });
}

export function renderShippedAnnouncementText(v: ShippedAnnouncementVars): string {
  return [
    `Shipped: ${v.title}`,
    shippedBody(v),
    v.productUrl ? `Open ${v.workspaceName}: ${v.productUrl}` : "",
    customerFooterText(sentFor[v.reason](v.workspaceName), v.unsubscribeUrl),
  ].filter(Boolean).join("\n\n");
}

// ─── Public follows (an address typed on the public pages) ──
// Visitors on /<slug>/roadmap and /<slug>/changelog follow by email, with no
// customer account behind them (lib/public-follows). Double opt-in: the
// confirmation carries no unsubscribe link (nothing is subscribed until they
// click); every update does.

export type PublicFollowConfirmVars = {
  workspaceName: string;
  /** The initiative followed; null for every update (the changelog's form). */
  initiativeName: string | null;
  link: string;
  ttlDays: number;
  /** The workspace's Branding dot color (#RRGGBB). */
  accent?: string | null;
};

const publicFollowAsk = (v: PublicFollowConfirmVars) =>
  `Confirm to get an email when ${v.initiativeName ? `${v.initiativeName} moves on ${v.workspaceName}'s roadmap` : `${v.workspaceName} posts an update`}. The link expires in ${ttlPhrase(v.ttlDays * 24 * 60)}.`;
const publicFollowAskReason = (ws: string) =>
  `You're getting this because someone entered this address on ${ws}'s public pages. Not you? Ignore it and nothing more is sent.`;

export function renderPublicFollowConfirmHtml(v: PublicFollowConfirmVars): string {
  return customerShell({
    workspaceName: v.workspaceName,
    accent: v.accent,
    reason: publicFollowAskReason(v.workspaceName),
    rows: `
          <tr><td style="padding:0 8px">
            <h1 style="margin:0 0 12px;font-size:18px;font-weight:600;letter-spacing:-0.01em">Confirm your email</h1>
            <p style="margin:0;font-size:14px;color:#4A2E1F">${escapeHtml(publicFollowAsk(v))}</p>
          </td></tr>
          <tr><td style="padding:24px 8px 0">
            ${buttonHtml(v.link, "Confirm")}
          </td></tr>`,
  });
}

export function renderPublicFollowConfirmText(v: PublicFollowConfirmVars): string {
  return [
    "Confirm your email",
    publicFollowAsk(v),
    `Confirm: ${v.link}`,
    customerFooterText(publicFollowAskReason(v.workspaceName)),
  ].join("\n\n");
}

export type PublicFollowUpdateVars = {
  workspaceName: string;
  kind: "roadmap_move" | "changelog";
  /** The initiative's name (a move) or the entry's title (a changelog post). */
  title: string;
  /** What changed ("moved to Now"), or the entry's text. */
  summary: string;
  /** The public roadmap or changelog page. */
  url: string | null;
  /** Following one initiative, or every update: picks the footer line. */
  scope: "initiative" | "all";
  unsubscribeUrl: string;
  /** The workspace's Branding dot color (#RRGGBB). */
  accent?: string | null;
};

const publicUpdateReason = (v: PublicFollowUpdateVars) => v.scope === "initiative"
  ? sentFor.follow(v.workspaceName)
  : `You're getting this because you asked ${v.workspaceName} for updates.`;
const publicUpdateCta = (v: PublicFollowUpdateVars) => (v.kind === "roadmap_move" ? "View the roadmap" : "Read the changelog");

export function renderPublicFollowUpdateHtml(v: PublicFollowUpdateVars): string {
  const lead = v.kind === "roadmap_move"
    ? `<h1 style="margin:0 0 12px;font-size:18px;font-weight:600;letter-spacing:-0.01em">A roadmap item you follow was updated</h1>
            <p style="margin:0;font-size:14px;color:#4A2E1F"><strong style="font-weight:600">${escapeHtml(v.title)}</strong>: ${escapeHtml(v.summary)}.</p>`
    : `<h1 style="margin:0 0 12px;font-size:18px;font-weight:600;letter-spacing:-0.01em">${escapeHtml(v.title)}</h1>
            ${v.summary.trim() ? paragraphsToHtml(v.summary.trim()) : ""}`;
  return customerShell({
    workspaceName: v.workspaceName,
    accent: v.accent,
    reason: publicUpdateReason(v),
    unsubscribeUrl: v.unsubscribeUrl,
    rows: `
          <tr><td style="padding:0 8px">
            ${lead}
          </td></tr>${v.url ? `
          <tr><td style="padding:24px 8px 0">
            ${buttonHtml(v.url, publicUpdateCta(v))}
          </td></tr>` : ""}`,
  });
}

export function renderPublicFollowUpdateText(v: PublicFollowUpdateVars): string {
  const move = v.kind === "roadmap_move";
  return [
    move ? "A roadmap item you follow was updated" : v.title,
    move ? `${v.title}: ${v.summary}.` : v.summary.trim(),
    v.url ? `${publicUpdateCta(v)}: ${v.url}` : "",
    customerFooterText(publicUpdateReason(v), v.unsubscribeUrl),
  ].filter(Boolean).join("\n\n");
}

// ─── New-signup notification (to the operator) ───────────────
// Internal ops notice: fires when someone completes self-serve signup, so the
// operator knows a new workspace exists. Factual, not customer-facing. Goes to
// CRUMB_OPS_EMAIL only — never to the new user. Sender/title fields are user-
// supplied, so everything interpolated here is escaped.

export type SignupNotificationVars = {
  workspaceName: string;
  adminName: string;
  adminEmail: string;
  slug: string;
  /** Dashboard root, for a convenience "Open Crumb" link. */
  dashboardUrl?: string | null;
};

export function renderSignupNotificationHtml(v: SignupNotificationVars): string {
  const ws = escapeHtml(v.workspaceName);
  const name = escapeHtml(v.adminName);
  const email = escapeHtml(v.adminEmail);
  const slug = escapeHtml(v.slug);
  const url = v.dashboardUrl ? escapeHtml(v.dashboardUrl) : null;
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">
          <tr><td style="padding:0 8px 24px">
            <div style="font-weight:600;font-size:18px;letter-spacing:-0.01em">Crumb</div>
            <div style="font-size:12px;color:#6B5C50">New signup</div>
          </td></tr>
          <tr><td style="padding:0 8px">
            <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.01em">${name} created a new workspace</h1>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1C1815;border-radius:10px;margin-bottom:20px">
              <tr><td style="padding:16px 18px;color:#FBF7F0;font-size:14px;line-height:1.7">
                <div><span style="color:#9C8C7E">Workspace</span> &nbsp;<strong style="font-weight:500">${ws}</strong></div>
                <div><span style="color:#9C8C7E">Slug</span> &nbsp;<span style="font-family:ui-monospace,JetBrains Mono,Menlo,monospace">${slug}</span></div>
                <div><span style="color:#9C8C7E">Admin</span> &nbsp;${name} &lt;<a href="mailto:${email}" style="color:#FBF7F0">${email}</a>&gt;</div>
              </td></tr>
            </table>
            ${url ? `
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
              <tr><td style="border-radius:8px;background:#1C1815">
                <a href="${url}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:500;color:#FBF7F0;text-decoration:none;border-radius:8px">Open Crumb</a>
              </td></tr>
            </table>` : ""}
          </td></tr>
          <tr><td style="padding:32px 8px 0;border-top:1px solid rgba(28,24,21,0.08)">
            <p style="margin:24px 0 0;font-size:11px;color:#8A7C70">
              You're receiving this because <span style="font-family:ui-monospace,Menlo,monospace">CRUMB_OPS_EMAIL</span> is set on this Crumb deployment. Unset it to stop these.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function renderSignupNotificationText(v: SignupNotificationVars): string {
  return `New signup on Crumb

${v.adminName} created a new workspace.

Workspace: ${v.workspaceName}
Slug:      ${v.slug}
Admin:     ${v.adminName} <${v.adminEmail}>
${v.dashboardUrl ? `\nOpen Crumb: ${v.dashboardUrl}` : ""}
You're receiving this because CRUMB_OPS_EMAIL is set on this Crumb deployment.`;
}

// ─── In-app support request (operator inbox) ─────────────────
// Sent to the deployment's support address when a teammate uses the in-app
// Help → Contact form. From is the noreply variant; Reply-To is set to the
// sender so the operator can reply to them directly from their mail client.

export type SupportRequestVars = {
  workspaceName: string;
  fromUserName: string;
  fromUserEmail: string;
  subject: string;
  message: string;
};

export function renderSupportRequestHtml(v: SupportRequestVars): string {
  const ws = escapeHtml(v.workspaceName);
  const name = escapeHtml(v.fromUserName);
  const email = escapeHtml(v.fromUserEmail);
  const subject = escapeHtml(v.subject);
  const body = escapeHtml(v.message).replace(/\n/g, "<br>");
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">
          <tr><td style="padding:0 8px 24px">
            <div style="font-weight:600;font-size:18px;letter-spacing:-0.01em">Crumb</div>
            <div style="font-size:12px;color:#6B5C50">Support request</div>
          </td></tr>
          <tr><td style="padding:0 8px">
            <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.01em">${subject}</h1>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1C1815;border-radius:10px;margin-bottom:20px">
              <tr><td style="padding:16px 18px;color:#FBF7F0;font-size:14px;line-height:1.7">
                <div><span style="color:#9C8C7E">From</span> &nbsp;${name} &lt;<a href="mailto:${email}" style="color:#FBF7F0">${email}</a>&gt;</div>
                <div><span style="color:#9C8C7E">Workspace</span> &nbsp;<strong style="font-weight:500">${ws}</strong></div>
              </td></tr>
            </table>
            <div style="font-size:14px;line-height:1.7;color:#1C1815;white-space:normal">${body}</div>
          </td></tr>
          <tr><td style="padding:32px 8px 0;border-top:1px solid rgba(28,24,21,0.08)">
            <p style="margin:24px 0 0;font-size:11px;color:#8A7C70">
              Sent from the in-app Help &rarr; Contact form. Reply directly to reach ${name}.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function renderSupportRequestText(v: SupportRequestVars): string {
  return `Support request · ${v.workspaceName}

${v.subject}

From:      ${v.fromUserName} <${v.fromUserEmail}>
Workspace: ${v.workspaceName}

${v.message}

—
Sent from the in-app Help → Contact form. Reply directly to reach ${v.fromUserName}.`;
}
