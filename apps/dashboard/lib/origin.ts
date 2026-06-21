import "server-only";

// The dashboard's public origin ("https://host"). Prefers CRUMB_APP_URL — the
// canonical origin, and the only reliable source behind a reverse proxy /
// Cloudflare Tunnel, where the forwarded host is the internal service address
// (e.g. 0.0.0.0:3000) rather than the public hostname. Falls back to the proxy
// headers for zero-config local/dev. Mirrors lib/integrations/callback-url.ts.
// Accepts anything with a `get()` — both `Request.headers` (a `Headers`) and
// `next/headers` `headers()` (a `ReadonlyHeaders`).
type HeaderGetter = { get(name: string): string | null };

export function originFromHeaders(h: HeaderGetter): string | null {
  const app = process.env.CRUMB_APP_URL?.trim();
  if (app) return app.replace(/\/+$/, "");
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return null;
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
