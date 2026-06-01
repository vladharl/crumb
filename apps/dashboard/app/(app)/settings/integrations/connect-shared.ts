// Shared helpers for the "Connect <provider>" buttons.
//
// The start* server actions either redirect to the provider's OAuth screen
// (success — `redirect()` surfaces client-side as a thrown NEXT_REDIRECT) or
// return a `{ ok: false, error }` for the gating cases (admin / plan / creds).
// The buttons must let the redirect propagate but show real errors instead of
// silently no-oping.

const ERROR_COPY: Record<string, string> = {
  forbidden: "Only workspace admins can connect integrations.",
  plan_required: "Connecting integrations needs the Team plan. Upgrade from Settings → Billing.",
  cannot_resolve_host: "Couldn't resolve the callback URL. Set CRUMB_APP_URL to this dashboard's origin.",
  slack_not_configured: "Slack isn't configured on this deployment yet.",
  linear_not_configured: "Linear isn't configured on this deployment yet.",
  jira_not_configured: "Jira isn't configured on this deployment yet.",
  github_not_configured: "GitHub isn't configured on this deployment yet.",
  hubspot_not_configured: "HubSpot isn't configured on this deployment yet.",
  salesforce_not_configured: "Salesforce isn't configured on this deployment yet.",
};

// A server-action redirect surfaces client-side as an error whose `digest`
// starts with "NEXT_REDIRECT". Those must be re-thrown so Next performs the
// navigation to the provider rather than being swallowed as a failure.
export function isRedirectError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "digest" in e &&
    typeof (e as { digest: unknown }).digest === "string" &&
    (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

export function connectErrorMessage(code: string): string {
  return ERROR_COPY[code] ?? "Couldn't start the connection. Please try again.";
}
