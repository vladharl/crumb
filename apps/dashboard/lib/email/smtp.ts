import "server-only";
import nodemailer from "nodemailer";
import type { EmailProvider, OutgoingEmail } from "./provider";

// Generic SMTP adapter — works against Postmark, SendGrid, Amazon SES,
// Mailgun, or self-hosted Postfix. Required env vars:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
//   CRUMB_EMAIL_FROM (e.g. "Crumb <crumb@yourdomain.com>")
// Optional:
//   SMTP_SECURE=true   — use implicit TLS on the connection (port 465);
//                        omit for STARTTLS upgrade on 587.
//
// Unlike the Resend adapter (Cloud-only, op moat), SMTP is OSS-side: a
// self-hoster brings their own SMTP relay credentials and gets the same
// transactional UX without paying for the hosted tier.
export function makeSmtpProvider(env: {
  host: string; port: number; user: string; pass: string;
  from: string; secure?: boolean;
}): EmailProvider {
  const transporter = nodemailer.createTransport({
    host: env.host,
    port: env.port,
    secure: env.secure ?? env.port === 465,
    auth: env.user || env.pass ? { user: env.user, pass: env.pass } : undefined,
  });

  return {
    name: "smtp",
    async send(m: OutgoingEmail) {
      try {
        const info = await transporter.sendMail({
          from: m.from ?? env.from,
          to: m.to,
          replyTo: m.replyTo,
          subject: m.subject,
          html: m.html,
          text: m.text,
          // List-Unsubscribe + threading. Nodemailer keeps a Message-ID given
          // here (it only generates one when none is set) and brackets
          // In-Reply-To / References itself, so no messageId/inReplyTo fields.
          headers: m.headers,
        });
        return { ok: true as const, providerMessageId: info.messageId ?? null };
      } catch (e: unknown) {
        const detail = e instanceof Error ? e.message : String(e);
        return { ok: false as const, error: "smtp_send_failed", detail };
      }
    },
  };
}
