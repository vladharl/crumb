import "server-only";

// Crumb ships from one repo to two deployment shapes:
//   - "self_host" (default): the OSS path. AGPL-licensed, runs on the
//     user's own infra. Free. No managed services bundled.
//   - "cloud":              the hosted tier at usecrumb.xyz. Same code,
//     extra env (RESEND_API_KEY, Slack app credentials, etc.) and
//     features unlocked via this gate.
//
// Anything that requires us to hold a secret on the customer's behalf —
// outbound email through a managed provider, OAuth-installed integrations,
// AI clustering — is Cloud-only. The code is present in the OSS source
// (AGPL doesn't allow hiding it anyway), but the gate refuses to run it
// without `CRUMB_TIER=cloud`.

export type Tier = "self_host" | "cloud";

export function getTier(): Tier {
  const raw = (process.env.CRUMB_TIER ?? "self_host").toLowerCase();
  return raw === "cloud" ? "cloud" : "self_host";
}

export function isCloud(): boolean {
  return getTier() === "cloud";
}

export function isSelfHost(): boolean {
  return getTier() === "self_host";
}

// Convenience for "feature X is Cloud-only". Returns true on self-host
// so callers can render a disabled / upsell state.
export function gatedOnCloud(): boolean {
  return !isCloud();
}
