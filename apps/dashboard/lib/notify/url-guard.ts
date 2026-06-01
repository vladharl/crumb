import "server-only";

// SSRF guard for user-pasted webhook URLs (vendor Teams, customer Slack/Teams).
// A malicious admin could paste an internal address; we require https + a SaaS
// host allowlist, and block private/loopback/link-local ranges. Enforced at
// set-time (settings/account actions, widget endpoint) AND post-time (chat.ts).
// CRUMB_WEBHOOK_ALLOW_ANY=1 is an escape hatch for self-host internal bridges
// (and lets e2e post to a localhost receiver).

const ALLOW_HOSTS: RegExp[] = [
  /(^|\.)hooks\.slack\.com$/i,
  /(^|\.)webhook\.office\.com$/i, // Teams legacy connector
  /(^|\.)logic\.azure\.com$/i,    // Teams "Workflows" (Power Automate)
];

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

export function assertSafeWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "bad_scheme" };
  // Escape hatch (self-host bridges + e2e): allow any http(s) host.
  if (process.env.CRUMB_WEBHOOK_ALLOW_ANY === "1") return { ok: true, url: url.toString() };
  if (url.protocol !== "https:") return { ok: false, error: "must_be_https" };
  if (isPrivateHost(url.hostname)) return { ok: false, error: "private_host" };
  if (!ALLOW_HOSTS.some((re) => re.test(url.hostname))) return { ok: false, error: "host_not_allowed" };
  return { ok: true, url: url.toString() };
}
