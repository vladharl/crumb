import "server-only";
import type { EmailProvider, OutgoingEmail, SendResult } from "./provider";

// A 429 is retried after its Retry-After (a second when it has none), at most
// MAX_ATTEMPTS sends and RETRY_BUDGET_MS of waiting in all; a Retry-After past
// what's left (a spent daily quota) fails at once. lib/email.ts already paces
// sends to the account's rate, so this only absorbs jitter and other senders.
const MAX_ATTEMPTS = 3;
const RETRY_BUDGET_MS = 5_000;

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return seconds > 0 ? seconds * 1000 : 1000;
}

// Resend (https://resend.com) adapter. Single HTTP call, no SDK.
// Requires:
//   RESEND_API_KEY      — `re_…` from the Resend dashboard
//   CRUMB_EMAIL_FROM    — verified sender, e.g. "Crumb <crumb@yourdomain.com>"
export function makeResendProvider(env: { apiKey: string; from: string }): EmailProvider {
  return {
    name: "resend",
    async send(m: OutgoingEmail): Promise<SendResult> {
      let waited = 0;
      for (let attempt = 1; ; attempt++) {
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
            headers: m.headers, // List-Unsubscribe + threading; dropped by JSON when unset
          }),
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          const wait = retryAfterMs(res.headers.get("retry-after"));
          if (res.status !== 429 || attempt >= MAX_ATTEMPTS || waited + wait > RETRY_BUDGET_MS) {
            return { ok: false, error: `resend_${res.status}`, detail };
          }
          waited += wait;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        const body = await res.json().catch(() => ({})) as { id?: string };
        return { ok: true, providerMessageId: body.id ?? null };
      }
    },
  };
}
