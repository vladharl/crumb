import { Card, CardHead, Ic, Pill } from "@crumb/ui";
import { activeEmailProvider, emailConfigured } from "@/lib/email";
import { isCloud } from "@/lib/tier";

/**
 * Email delivery status + operator guidance. Lives on the settings Overview
 * (it's setup state, not an audit record — it used to hide on the Audit page
 * where the name gave no hint it existed). Detail is admin-only; the checklist
 * row above it carries the everyone-visible status.
 */
export function EmailDeliveryCard({ isAdmin }: { isAdmin: boolean }) {
  const email = activeEmailProvider();
  const configured = emailConfigured();
  const cloud = isCloud();

  return (
    <Card>
      <CardHead title="Email delivery" after={
        configured
          ? <Pill ring ringFill>{email.name}</Pill>
          : <Pill>stdout (dev)</Pill>
      } />
      <div className="card-body col gap-3">
        {!isAdmin ? (
          <p className="text-sm muted" style={{ margin: 0 }}>
            Only workspace admins can see email configuration.
          </p>
        ) : configured ? (
          <div className="row gap-3 center" style={{ flexWrap: "wrap" }}>
            <Ic.check style={{ width: 14, height: 14, color: "var(--accent-deep)" }} />
            <span className="text-sm">
              Sending via <strong style={{ fontWeight: 500 }}>{email.name}</strong> as <span className="mono">{email.from}</span>.
            </span>
          </div>
        ) : cloud ? (
          <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
            You're on Crumb Cloud, but no email provider is configured. Set <span className="mono">CRUMB_EMAIL_PROVIDER=resend</span>, <span className="mono">RESEND_API_KEY</span>, and <span className="mono">CRUMB_EMAIL_FROM</span> to enable delivery.
          </p>
        ) : (
          <>
            <p className="text-sm" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
              Magic-link and notification emails are being printed to the dashboard's stdout. Bring your own relay with <span className="mono">CRUMB_EMAIL_PROVIDER=smtp</span> plus <span className="mono">SMTP_HOST</span>, <span className="mono">SMTP_PORT</span>, <span className="mono">SMTP_USER</span>, <span className="mono">SMTP_PASS</span>, and <span className="mono">CRUMB_EMAIL_FROM</span>.
            </p>
            <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
              Until then, read magic links from <span className="mono">docker compose logs dashboard</span>. Prefer managed delivery? <a href="https://crumb.localhostlabs.net" style={{ color: "var(--ink)" }}>Crumb Cloud</a> includes it.
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
