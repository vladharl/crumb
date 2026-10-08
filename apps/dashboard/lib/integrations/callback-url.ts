import "server-only";
import { headers } from "next/headers";
import { originFromHeaders } from "@/lib/origin";

// Single source of truth for an OAuth provider's redirect_uri.
//
// The authorize step (a server action, via next/headers) and the token-exchange
// step (the callback route, via the incoming Request) MUST produce the SAME
// string, or the provider rejects the exchange with `redirect_uri_mismatch`.
// Both go through here with identical precedence:
//   1. CRUMB_APP_URL — the canonical dashboard origin. The recommended single
//      knob on Cloud / behind a proxy, where guessing from forwarded headers is
//      brittle.
//   2. the provider's explicit *_REDIRECT_URL override (tunnels / odd setups).
//   3. the incoming request host (x-forwarded-host / Host, as lib/origin reads
//      it) — zero-config default. Never req.url: behind a proxy that is the
//      internal address (http://0.0.0.0:3000), which the authorize step never used.

function appUrl(): string | null {
  const raw = process.env.CRUMB_APP_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

function callbackPath(provider: string): string {
  return `/api/integrations/${provider}/callback`;
}

// Used by the authorize step (server action) — only has next/headers().
export function callbackUrlFromHeaders(provider: string, override: string | null): string {
  const app = appUrl();
  if (app) return `${app}${callbackPath(provider)}`;
  if (override) return override;
  const origin = originFromHeaders(headers());
  if (!origin) throw new Error("cannot_resolve_host");
  return `${origin}${callbackPath(provider)}`;
}

// Used by the callback route (token exchange) — has the incoming Request.
export function callbackUrlFromRequest(provider: string, override: string | null, req: Request): string {
  const app = appUrl();
  if (app) return `${app}${callbackPath(provider)}`;
  if (override) return override;
  return `${originFromHeaders(req.headers) ?? new URL(req.url).origin}${callbackPath(provider)}`;
}
