"use client";

import { useEffect } from "react";

// Cloudflare Turnstile widget for the signup form. Turnstile injects a hidden
// input named "cf-turnstile-response" into the surrounding <form>, which the
// startSignup action reads and verifies server-side (lib/turnstile.ts).
//
// The site key is passed in from the server (page.tsx reads TURNSTILE_SITE_KEY
// at runtime) so it works without a rebuild. No-op when unset (local/dev) — the
// server verify also treats a missing secret as "not enforced", so the flow
// works with zero config until both keys are set in production.
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

export function TurnstileWidget({ siteKey }: { siteKey?: string | null }) {
  useEffect(() => {
    if (!siteKey) return;
    if (document.querySelector(`script[src="${SCRIPT_SRC}"]`)) return;
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }, [siteKey]);

  if (!siteKey) return null;
  return <div className="cf-turnstile" data-sitekey={siteKey} data-theme="light" />;
}
