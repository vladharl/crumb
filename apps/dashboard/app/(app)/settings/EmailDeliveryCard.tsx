import { Card, CardHead, Ic, Pill } from "@crumb/ui";
import { activeEmailProvider, emailConfigured } from "@/lib/email";
import { log } from "@/lib/log";
import { isCloud } from "@/lib/tier";

/**
 * Email delivery status + operator guidance. Lives on the settings Overview
 * (it's setup state, not an audit record — it used to hide on the Audit page
 * where the name gave no hint it existed). Detail is admin-only; the checklist
 * row above it carries the everyone-visible status. Env var names show only to
 * self-host admins, who run the server. A Cloud workspace can't set them, so
 * on Cloud they go to the server log instead.
 */
export function EmailDeliveryCard({ isAdmin }: { isAdmin: boolean }) {
  const email = activeEmailProvider();
  const configured = emailConfigured();
  const cloud = isCloud();
  if (cloud && !configured) {
    log.warn("email delivery isn't configured on Cloud: set CRUMB_EMAIL_PROVIDER=resend, RESEND_API_KEY and CRUMB_EMAIL_FROM", { scope: "crumb/email" });
  }

  return (
    <Card>
      <CardHead title="Email delivery" after={
        configured
          ? <Pill ring ringFill>{email.name}</Pill>
          : <Pill>Not set up</Pill>
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
          <p className="text-sm muted note">
            Email isn't set up on Crumb Cloud right now. Contact support.
          </p>
        ) : (
          <>
            <p className="text-sm note">
              Sign-in and notification emails aren't being sent: Crumb writes them to the dashboard's logs instead. Bring your own relay with <span className="mono">CRUMB_EMAIL_PROVIDER=smtp</span> plus <span className="mono">SMTP_HOST</span>, <span className="mono">SMTP_PORT</span>, <span className="mono">SMTP_USER</span>, <span className="mono">SMTP_PASS</span>, and <span className="mono">CRUMB_EMAIL_FROM</span>.
            </p>
            <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55, maxWidth: "62ch" }}>
              Until then, read sign-in links from <span className="mono">docker compose logs dashboard</span>. Prefer managed delivery? <a href="https://crumb.localhostlabs.net" style={{ color: "var(--ink)" }}>Crumb Cloud</a> includes it.
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
