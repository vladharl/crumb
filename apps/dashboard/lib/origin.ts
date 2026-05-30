import "server-only";

// Build "https://host" from request/Next headers, honoring the proxy headers a
// reverse proxy sets. Accepts anything with a `get()` — both `Request.headers`
// (a `Headers`) and `next/headers` `headers()` (a `ReadonlyHeaders`).
type HeaderGetter = { get(name: string): string | null };

export function originFromHeaders(h: HeaderGetter): string | null {
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return null;
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
