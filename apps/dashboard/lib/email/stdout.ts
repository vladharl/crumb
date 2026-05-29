import "server-only";
import type { EmailProvider, OutgoingEmail } from "./provider";

// Logs delivery to stdout. Default for dev and self-hosters who haven't
// configured a real provider — they can read magic links from the
// dashboard's logs (e.g. `docker compose logs dashboard`).
export const stdoutProvider: EmailProvider = {
  name: "stdout",
  async send(m: OutgoingEmail) {
    // eslint-disable-next-line no-console
    console.log(`
─── crumb · email (stdout) ──────────────────────────
  to:      ${m.to}
${m.from ? `  from:    ${m.from}\n` : ""}${m.replyTo ? `  reply-to:${m.replyTo}\n` : ""}  subject: ${m.subject}
${m.previewLine ? `  preview: ${m.previewLine}\n` : ""}${m.link ? `  link:    ${m.link}\n` : ""}─────────────────────────────────────────────────────
`);
    return { ok: true as const, providerMessageId: null };
  },
};
