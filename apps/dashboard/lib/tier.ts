import "server-only";

// Crumb ships from one repo to two deployment shapes:
//   - "self_host" (default): the OSS path. AGPL-licensed, runs on the
//     user's own infra. Free. No managed services bundled.
//   - "cloud":              the hosted tier at usecrumb.xyz. Same code,
//     extra env (RESEND_API_KEY, Slack app credentials, etc.) and
//     features unlocked via this gate.
//
// Gating policy (two distinct kinds — don't conflate them):
//
//   1. Capability-gated (BYO unlocks on self-host): third-party
//      integrations (Slack / Linear / Jira / GitHub) and managed email.
//      A self-hoster who supplies their own OAuth-app creds / SMTP relay
//      gets the feature — the `*Configured()` checks gate on creds-present,
//      not on tier. Cloud just pre-supplies those creds.
//
//   2. Hard Cloud-only + plan-gated (the paid differentiators): AI
//      clustering / ticket drafts and Session Record. These require BOTH
//      `isCloud()` AND a workspace plan entitlement (see lib/entitlements.ts)
//      — a BYO Anthropic key or storage does NOT unlock them on self-host.
//      This is a monetization gate, by design.
//
// All code ships in the OSS source either way (AGPL doesn't allow hiding
// it); the gates decide what actually runs. `isCloud()` answers "is this
// the hosted product?"; lib/entitlements answers "does THIS workspace's
// plan include feature X?".

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
