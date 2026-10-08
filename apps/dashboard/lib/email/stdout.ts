import "server-only";
import type { EmailProvider, OutgoingEmail } from "./provider";

// Prints the email to stdout instead of delivering it. Default for dev and
// self-hosters who haven't configured a real provider — they can read magic
// links from the dashboard's logs (e.g. `docker compose logs dashboard`).
// `ok` here means "printed": lib/email.ts never counts a stdout send as a
// customer delivery (the loop ledger records only real ones).
export const stdoutProvider: EmailProvider = {
  name: "stdout",
  async send(m: OutgoingEmail) {
    const headers = Object.entries(m.headers ?? {}).map(([k, v]) => `  ${k}: ${v}\n`).join("");
    // eslint-disable-next-line no-console
    console.log(`
─── crumb · email (stdout) ──────────────────────────
  to:      ${m.to}
${m.from ? `  from:    ${m.from}\n` : ""}${m.replyTo ? `  reply-to:${m.replyTo}\n` : ""}  subject: ${m.subject}
${m.previewLine ? `  preview: ${m.previewLine}\n` : ""}${m.link ? `  link:    ${m.link}\n` : ""}${headers}─────────────────────────────────────────────────────
`);
    return { ok: true as const, providerMessageId: null };
  },
};
