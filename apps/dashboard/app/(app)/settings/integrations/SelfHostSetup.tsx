import type { Provider } from "@/lib/integrations/state";

// Self-host BYO-OAuth setup helper. Shows the exact values an operator must
// paste into the provider's app config — callback/redirect URL, webhook URL,
// scopes/permissions, and the env vars to set. Removes the #1 source of
// failed self-host installs (wrong redirect URL / missing scope). Rendered
// only on self-host when the provider's creds aren't configured yet.

type Row = { label: string; value: string; mono?: boolean };

function setupFor(provider: Provider, origin: string): { rows: Row[]; env: string[]; docs: string } {
  const cb = (p: string) => `${origin}/api/integrations/${p}/callback`;
  const wh = (p: string) => `${origin}/api/integrations/${p}/webhook`;
  switch (provider) {
    case "slack":
      return {
        rows: [
          { label: "Redirect URL", value: cb("slack"), mono: true },
          { label: "Bot scopes", value: "chat:write, im:write, users:read, users:read.email, commands", mono: true },
          { label: "Slash command (/crumb) Request URL", value: `${origin}/api/integrations/slack/commands`, mono: true },
          { label: "Interactivity Request URL", value: `${origin}/api/integrations/slack/interactivity`, mono: true },
        ],
        env: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET (for the slash command)"],
        docs: "https://api.slack.com/apps",
      };
    case "linear":
      return {
        rows: [
          { label: "Redirect URL", value: cb("linear"), mono: true },
          { label: "Scopes", value: "read, write", mono: true },
          { label: "Webhook URL (optional, status sync)", value: wh("linear"), mono: true },
        ],
        env: ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET (optional)"],
        docs: "https://linear.app/settings/api",
      };
    case "jira":
      return {
        rows: [
          { label: "Callback URL", value: cb("jira"), mono: true },
          { label: "Scopes", value: "read:jira-work, write:jira-work, read:jira-user, offline_access", mono: true },
          { label: "Webhook URL (optional, status sync)", value: wh("jira"), mono: true },
        ],
        env: ["JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET", "JIRA_WEBHOOK_SECRET (optional)"],
        docs: "https://developer.atlassian.com/console/myapps/",
      };
    case "github":
      return {
        rows: [
          { label: "Callback URL", value: cb("github"), mono: true },
          { label: "Webhook URL", value: wh("github"), mono: true },
          { label: "Permissions", value: "Issues: R/W · Contents: R · Metadata: R", mono: false },
          { label: "Subscribe to events", value: "Issues, Installation", mono: true },
        ],
        env: ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"],
        docs: "https://github.com/settings/apps/new",
      };
    case "hubspot":
      return {
        rows: [
          { label: "Redirect URL", value: cb("hubspot"), mono: true },
          { label: "Scopes", value: "crm.objects.companies.read", mono: true },
        ],
        env: ["HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET"],
        docs: "https://developers.hubspot.com/docs/api/oauth-quickstart-guide",
      };
    case "salesforce":
      return {
        rows: [
          { label: "Callback URL", value: cb("salesforce"), mono: true },
          { label: "OAuth scopes", value: "api, refresh_token", mono: true },
          { label: "Sandbox?", value: "set SALESFORCE_LOGIN_URL=https://test.salesforce.com", mono: false },
        ],
        env: ["SALESFORCE_CLIENT_ID", "SALESFORCE_CLIENT_SECRET"],
        docs: "https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm",
      };
  }
}

export function SelfHostSetup({ provider, origin }: { provider: Provider; origin: string | null }) {
  const { rows, env, docs } = setupFor(provider, origin ?? "https://your-dashboard.example.com");
  const label = provider === "github" ? "GitHub App" : "OAuth app";
  return (
    <details style={{ borderTop: "var(--border)", paddingTop: 10 }}>
      <summary className="text-xs" style={{ cursor: "pointer", color: "var(--ink)" }}>
        Self-host setup — create your {label} with these values
      </summary>
      <div className="col gap-2" style={{ marginTop: 10 }}>
        {rows.map(r => (
          <div key={r.label} className="col gap-1">
            <span className="eyebrow">{r.label}</span>
            {r.mono
              ? <div className="code" style={{ wordBreak: "break-all" }}>{r.value}</div>
              : <span className="text-xs">{r.value}</span>}
          </div>
        ))}
        <div className="col gap-1">
          <span className="eyebrow">Then set + restart</span>
          <div className="code" style={{ wordBreak: "break-all" }}>{env.join("  ·  ")}</div>
        </div>
        <a href={docs} target="_blank" rel="noreferrer" className="text-xs" style={{ color: "var(--ink)" }}>
          Register the app →
        </a>
      </div>
    </details>
  );
}
