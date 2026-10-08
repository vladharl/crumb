import "server-only";
import { statusLabel } from "@crumb/ui";

export type MagicLinkVars = {
  workspaceName?: string;
  link: string;
  ttlMinutes: number;
};

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

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
                <td style="padding-right:10px">
                  <svg width="28" height="28" viewBox="-5 -5 42 42" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="16" cy="3"  r="3.0" fill="#E27D3A" fill-opacity="0.45"/>
                    <circle cx="28" cy="11" r="3.5" fill="#E27D3A" fill-opacity="0.62"/>
                    <circle cx="28" cy="22" r="4.0" fill="#E27D3A" fill-opacity="0.80"/>
                    <circle cx="17" cy="29" r="4.5" fill="#E27D3A" fill-opacity="0.94"/>
                    <circle cx="4"  cy="22" r="5.0" fill="#E27D3A"/>
                  </svg>
                </td>
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
                <td style="padding-right:10px">
                  <svg width="28" height="28" viewBox="-5 -5 42 42" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="16" cy="3"  r="3.0" fill="#E27D3A" fill-opacity="0.45"/>
                    <circle cx="28" cy="11" r="3.5" fill="#E27D3A" fill-opacity="0.62"/>
                    <circle cx="28" cy="22" r="4.0" fill="#E27D3A" fill-opacity="0.80"/>
                    <circle cx="17" cy="29" r="4.5" fill="#E27D3A" fill-opacity="0.94"/>
                    <circle cx="4"  cy="22" r="5.0" fill="#E27D3A"/>
                  </svg>
                </td>
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

// ─── Reply notification ─────────────────────────────────────
// Sent to the customer when a vendor (PM) replies on a thread.
// The email is fully self-contained — no clickable "open in widget"
// link yet, since the widget lives inside the customer's product
// at an unknown URL. The customer reads the reply here, then opens
// the widget in their product when they want to respond.

export type ReplyNotificationVars = {
  workspaceName: string;     // e.g. "Southbeam"
  vendorName: string;        // e.g. "Lina Rivers"
  itemShortId: string;       // e.g. "FB-247"
  itemTitle: string;
  replyBody: string;
  /** Brief status (e.g. "In review") — optional. */
  statusLabel?: string;
  /** When set, the email shows a "View thread" button pointing at the host product. */
  threadUrl?: string | null;
  /** One-click unsubscribe link (per-customer token). Adds a footer link. */
  unsubscribeUrl?: string | null;
};

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

function truncate(s: string, max = 600): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function paragraphsToHtml(body: string): string {
  // Naive: split on double-newlines into <p>, escape, preserve single newlines as <br>.
  return body
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#1C1815">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function renderReplyNotificationHtml(v: ReplyNotificationVars): string {
  const ws = escapeHtml(v.workspaceName);
  const vendor = escapeHtml(v.vendorName);
  const shortId = escapeHtml(v.itemShortId);
  const title = escapeHtml(v.itemTitle);
  const body = paragraphsToHtml(truncate(v.replyBody));
  const status = v.statusLabel ? `<span style="margin-left:8px;padding:2px 8px;border:1px solid rgba(28,24,21,0.18);border-radius:999px;font-size:11px;color:#4A2E1F">${escapeHtml(v.statusLabel)}</span>` : "";

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">
          <tr><td style="padding:0 8px 20px">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:10px">
                  <svg width="26" height="26" viewBox="-5 -5 42 42" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="16" cy="3"  r="3.0" fill="#E27D3A" fill-opacity="0.45"/>
                    <circle cx="28" cy="11" r="3.5" fill="#E27D3A" fill-opacity="0.62"/>
                    <circle cx="28" cy="22" r="4.0" fill="#E27D3A" fill-opacity="0.80"/>
                    <circle cx="17" cy="29" r="4.5" fill="#E27D3A" fill-opacity="0.94"/>
                    <circle cx="4"  cy="22" r="5.0" fill="#E27D3A"/>
                  </svg>
                </td>
                <td>
                  <div style="font-weight:600;font-size:17px;letter-spacing:-0.01em">${ws}</div>
                  <div style="font-size:11px;color:#6B5C50;font-family:ui-monospace,JetBrains Mono,Menlo,monospace">${shortId}${status}</div>
                </td>
              </tr>
            </table>
          </td></tr>

          <tr><td style="padding:0 8px 8px">
            <h1 style="margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:-0.01em">${vendor} replied to your feedback</h1>
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

          ${v.threadUrl ? `
          <tr><td style="padding:24px 8px 0">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr><td style="border-radius:8px;background:#4A2E1F">
                <a href="${escapeHtml(v.threadUrl)}" style="display:inline-block;padding:9px 18px;font-size:13px;font-weight:500;color:#FBF7F0;text-decoration:none;border-radius:8px">
                  View thread →
                </a>
              </td></tr>
            </table>
          </td></tr>` : `
          <tr><td style="padding:24px 8px 0">
            <p style="margin:0 0 8px;font-size:13px;color:#6B5C50">
              To reply, open Crumb inside ${ws} where you submitted this.
            </p>
          </td></tr>`}

          <tr><td style="padding:32px 8px 0;border-top:1px solid rgba(28,24,21,0.08);margin-top:32px">
            <p style="margin:24px 0 0;font-size:11px;color:#8A7C70">
              You're getting this because you submitted feedback to ${ws} on Crumb. Follow the trail at <a href="https://crumb.localhostlabs.net" style="color:#8A7C70">crumb.localhostlabs.net</a>.${unsubLinkHtml(v.unsubscribeUrl)}
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

// ─── Status change notification ──────────────────────────────
// Sent to the customer when the PM moves an item to a new status.
// "Won't ship" and "Set aside" carry the most weight; "Shipped" is the
// joyful one. The email leans on the same dark Crumb-ink block style
// so it feels like a sibling of the reply notification.

export type StatusChangeVars = {
  workspaceName: string;
  vendorName: string;
  itemShortId: string;
  itemTitle: string;
  fromStatus: string | null;
  toStatus: string;
  reason?: string | null;
  /** When set, the email shows a "View thread" button pointing at the host product. */
  threadUrl?: string | null;
  /** One-click unsubscribe link (per-customer token). Adds a footer link. */
  unsubscribeUrl?: string | null;
};

const STATUS_BLURBS: Record<string, string> = {
  review:    "A PM is scoping this with the team.",
  planned:   "Picked up for an upcoming release.",
  progress:  "Engineering has started work.",
  shipped:   "Live now. Thanks for pushing on this one.",
  declined:  "We're not building this. Open the thread for the reasoning.",
  deferred:  "Set aside for now. We'll revisit and ping you.",
  duplicate: "We're tracking this under another item.",
};

export function renderStatusChangeHtml(v: StatusChangeVars): string {
  const ws = escapeHtml(v.workspaceName);
  const vendor = escapeHtml(v.vendorName);
  const shortId = escapeHtml(v.itemShortId);
  const title = escapeHtml(v.itemTitle);
  const toLabel = escapeHtml(statusLabel(v.toStatus));
  const fromLabel = v.fromStatus ? escapeHtml(statusLabel(v.fromStatus)) : "";
  const blurb = escapeHtml(STATUS_BLURBS[v.toStatus] ?? "");

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">
          <tr><td style="padding:0 8px 20px">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:10px">
                  <svg width="26" height="26" viewBox="-5 -5 42 42" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="16" cy="3"  r="3.0" fill="#E27D3A" fill-opacity="0.45"/>
                    <circle cx="28" cy="11" r="3.5" fill="#E27D3A" fill-opacity="0.62"/>
                    <circle cx="28" cy="22" r="4.0" fill="#E27D3A" fill-opacity="0.80"/>
                    <circle cx="17" cy="29" r="4.5" fill="#E27D3A" fill-opacity="0.94"/>
                    <circle cx="4"  cy="22" r="5.0" fill="#E27D3A"/>
                  </svg>
                </td>
                <td>
                  <div style="font-weight:600;font-size:17px;letter-spacing:-0.01em">${ws}</div>
                  <div style="font-size:11px;color:#6B5C50;font-family:ui-monospace,JetBrains Mono,Menlo,monospace">${shortId}</div>
                </td>
              </tr>
            </table>
          </td></tr>

          <tr><td style="padding:0 8px 8px">
            <h1 style="margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:-0.01em">${title}</h1>
            <p style="margin:0 0 16px;font-size:14px;color:#4A2E1F">
              ${vendor} moved this${fromLabel ? ` from <strong style="font-weight:500">${fromLabel}</strong>` : ""} to <strong style="font-weight:500">${toLabel}</strong>.
            </p>
          </td></tr>

          <tr><td style="padding:0 8px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1C1815;border-radius:10px">
              <tr><td style="padding:16px 18px;color:#FBF7F0;font-size:14px;line-height:1.55">
                <strong style="display:block;font-weight:500;margin-bottom:4px">${toLabel}</strong>
                ${blurb}
                ${v.reason ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(251,247,240,0.12);font-size:13px;color:#DCC9B6">${escapeHtml(v.reason).replace(/\n/g, "<br>")}</div>` : ""}
              </td></tr>
            </table>
          </td></tr>

          ${v.threadUrl ? `
          <tr><td style="padding:24px 8px 0">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr><td style="border-radius:8px;background:#4A2E1F">
                <a href="${escapeHtml(v.threadUrl)}" style="display:inline-block;padding:9px 18px;font-size:13px;font-weight:500;color:#FBF7F0;text-decoration:none;border-radius:8px">
                  View thread →
                </a>
              </td></tr>
            </table>
          </td></tr>` : `
          <tr><td style="padding:24px 8px 0">
            <p style="margin:0 0 8px;font-size:13px;color:#6B5C50">
              Open Crumb inside ${ws} to read the full thread or reply.
            </p>
          </td></tr>`}

          <tr><td style="padding:32px 8px 0;border-top:1px solid rgba(28,24,21,0.08);margin-top:32px">
            <p style="margin:24px 0 0;font-size:11px;color:#8A7C70">
              You're getting this because you submitted feedback to ${ws} on Crumb. <a href="https://crumb.localhostlabs.net" style="color:#8A7C70">crumb.localhostlabs.net</a>${unsubLinkHtml(v.unsubscribeUrl)}
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function renderStatusChangeText(v: StatusChangeVars): string {
  const toLabel = statusLabel(v.toStatus);
  const fromLabel = v.fromStatus ? statusLabel(v.fromStatus) : null;
  const blurb = STATUS_BLURBS[v.toStatus] ?? "";
  return `${v.workspaceName} · ${v.itemShortId}
${v.itemTitle}

${v.vendorName} moved this${fromLabel ? ` from ${fromLabel}` : ""} to ${toLabel}.

${toLabel}: ${blurb}${v.reason ? `\n\n${v.reason}` : ""}

${v.threadUrl ? `View thread: ${v.threadUrl}` : `Open Crumb inside ${v.workspaceName} to read the full thread or reply.`}${unsubLineText(v.unsubscribeUrl)}`;
}

// (intentionally placed below renderReplyNotificationHtml; the text-mode
// version follows the same vars shape and surfaces threadUrl as a plain line.)
export function renderReplyNotificationText(v: ReplyNotificationVars): string {
  const status = v.statusLabel ? `   [${v.statusLabel}]` : "";
  return `${v.vendorName} replied to your feedback on Crumb.

${v.workspaceName} · ${v.itemShortId}${status}
${v.itemTitle}

---
${truncate(v.replyBody)}
---

${v.threadUrl ? `View thread: ${v.threadUrl}` : `To reply, open Crumb inside ${v.workspaceName} where you submitted this.`}${unsubLineText(v.unsubscribeUrl)}`;
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
  const body = paragraphsToHtml(truncate(v.noteBody));
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
${truncate(v.noteBody)}
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
  const body = paragraphsToHtml(truncate(v.replyBody));

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">
          <tr><td style="padding:0 8px 20px">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:10px">
                  <svg width="26" height="26" viewBox="-5 -5 42 42" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="16" cy="3"  r="3.0" fill="#E27D3A" fill-opacity="0.45"/>
                    <circle cx="28" cy="11" r="3.5" fill="#E27D3A" fill-opacity="0.62"/>
                    <circle cx="28" cy="22" r="4.0" fill="#E27D3A" fill-opacity="0.80"/>
                    <circle cx="17" cy="29" r="4.5" fill="#E27D3A" fill-opacity="0.94"/>
                    <circle cx="4"  cy="22" r="5.0" fill="#E27D3A"/>
                  </svg>
                </td>
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
${truncate(v.replyBody)}
---

${v.dashboardThreadUrl ? `Open in Crumb: ${v.dashboardThreadUrl}` : `Open the thread in your Crumb dashboard to reply.`}`;
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
  change: string; // e.g. "moved to Now" / "shipped"
  productUrl?: string | null;
  unsubscribeUrl?: string | null;
};

export function renderRoadmapUpdateHtml(v: RoadmapUpdateVars): string {
  const ws = escapeHtml(v.workspaceName);
  const name = escapeHtml(v.initiativeName);
  const change = escapeHtml(v.change);
  const url = v.productUrl ? escapeHtml(v.productUrl) : null;
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#FBF7F0;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif;color:#1C1815;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0">
      <tr><td align="center" style="padding:48px 16px">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">
          <tr><td style="padding:0 8px 24px">
            <div style="font-weight:600;font-size:18px;letter-spacing:-0.01em">Crumb</div>
            <div style="font-size:12px;color:#6B5C50">Roadmap · ${ws}</div>
          </td></tr>
          <tr><td style="padding:0 8px">
            <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.01em">A roadmap item you follow was updated</h1>
            <p style="margin:0 0 20px;font-size:14px;color:#4A2E1F">
              <strong style="font-weight:600">${name}</strong>: ${change}.
            </p>
            ${url ? `
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
              <tr><td style="border-radius:8px;background:#1C1815">
                <a href="${url}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:500;color:#FBF7F0;text-decoration:none;border-radius:8px">View the roadmap</a>
              </td></tr>
            </table>` : ""}
          </td></tr>
          <tr><td style="padding:32px 8px 0;border-top:1px solid rgba(28,24,21,0.08)">
            <p style="margin:24px 0 0;font-size:11px;color:#8A7C70">
              You're getting this because you follow this item on ${ws}'s roadmap. Open the widget to unfollow.${unsubLinkHtml(v.unsubscribeUrl)}
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function renderRoadmapUpdateText(v: RoadmapUpdateVars): string {
  return `A roadmap item you follow was updated

${v.initiativeName}: ${v.change}.

${v.productUrl ? `View the roadmap: ${v.productUrl}` : "Open the widget in your product to see the roadmap."}

You're getting this because you follow this item on ${v.workspaceName}'s roadmap.${unsubLineText(v.unsubscribeUrl)}`;
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
