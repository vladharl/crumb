import "server-only";
import type { EmailProvider, OutgoingEmail } from "./provider";

// Resend (https://resend.com) adapter. Single HTTP call, no SDK.
// Requires:
//   RESEND_API_KEY      — `re_…` from the Resend dashboard
//   CRUMB_EMAIL_FROM    — verified sender, e.g. "Crumb <crumb@yourdomain.com>"
export function makeResendProvider(env: { apiKey: string; from: string }): EmailProvider {
  return {
    name: "resend",
    async send(m: OutgoingEmail) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: m.from ?? env.from,
          to: [m.to],
          ...(m.replyTo ? { reply_to: [m.replyTo] } : {}),
          subject: m.subject,
          html: m.html,
          text: m.text,
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return { ok: false as const, error: `resend_${res.status}`, detail };
      }

      const body = await res.json().catch(() => ({})) as { id?: string };
      return { ok: true as const, providerMessageId: body.id ?? null };
    },
  };
}
