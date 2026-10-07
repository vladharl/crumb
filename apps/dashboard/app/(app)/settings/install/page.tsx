import { headers } from "next/headers";
import { Card, CardHead, Pill } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { isCloud } from "@/lib/tier";
import { buildInboxAddress, inboundSecret } from "@/lib/inbound-address";
import { SecretReveal } from "./SecretReveal";
import { Snippet } from "./CopySnippetButton";
import { SigningExamples } from "./SigningExamples";
import { TryWidget } from "./TryWidget";
import { WidgetStatus } from "./WidgetStatus";
import { installSnippets } from "./snippets";
import { TEST_CUSTOMER_ACCOUNT } from "./test-customer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Install · Settings" };

export default async function InstallPage() {
  const { workspace, user } = await getActiveSession();
  const cloud = isCloud();
  const s = installSnippets(headers(), workspace.slug);
  const inboundDomain = process.env.CRUMB_INBOUND_DOMAIN?.trim() || null;
  // The capture address only verifies when CRUMB_INBOUND_SECRET signs it.
  const captureAddress = inboundDomain && inboundSecret() ? buildInboxAddress(workspace.slug, inboundDomain) : null;

  return (
    <>
      <Card>
        <CardHead title="Try it" />
        <div className="card-body col gap-4">
          <p className="text-md muted note">
            See the real widget before you write any server code. It signs you in as a test customer, so whatever you send lands in your Inbox under {TEST_CUSTOMER_ACCOUNT} and won&apos;t count as your install. Answer it from the Inbox, then reopen the preview to see your reply land.
          </p>
          <TryWidget origin={s.origin} slug={workspace.slug} canTry={user.role === "admin" || user.role === "pm"} />
        </div>
      </Card>

      <Card>
        <CardHead title="Install the widget" after={!cloud && <Pill ring ringFill>Recommended</Pill>} />
        <div className="card-body col gap-4">
          <p className="text-md muted note">
            Add this tag to the pages where your customers are signed in. Your server signs a short-lived token for that customer with the workspace&apos;s secret; the widget sends it on every call, and Crumb trusts the signed claims, never the page.
          </p>

          <Snippet title="Install snippet" code={s.install} />
          <WidgetStatus initial={workspace.widgetFirstPingAt?.toISOString() ?? null} />

          <p className="text-sm muted note">
            Sign the token with HS256: <span className="mono">iss</span> is your workspace slug (<span className="mono">{workspace.slug}</span>), <span className="mono">sub</span> the customer&apos;s email, <span className="mono">account_name</span> their company, and <span className="mono">exp</span> about an hour out.
          </p>
          <SigningExamples examples={s.signing} />

          <SecretReveal isAdmin={user.role === "admin"} />
        </div>
      </Card>

      {!cloud && (
        <Card>
          <CardHead title="Development snippet" after={<Pill ring>Self-host only</Pill>} />
          <div className="card-body col gap-4">
            <p className="text-md muted note">
              For demos and the bundled <span className="mono">/widget-demo.html</span>, the widget accepts identity from <span className="mono">data-*</span> attributes. Anyone with view-source can impersonate; switch to the signed token before going to production.
            </p>

            <Snippet title="Unsigned snippet" code={s.dev} />

            <a
              href={`/widget-demo.html?ws=${encodeURIComponent(workspace.slug)}&email=customer@example.com&account=${encodeURIComponent(TEST_CUSTOMER_ACCOUNT)}&name=Customer`}
              target="_blank"
              rel="noreferrer"
              className="text-sm"
              style={{ color: "var(--ink)", alignSelf: "flex-start" }}
            >
              Open the demo embed →
            </a>
          </div>
        </Card>
      )}

      <Card>
        <CardHead title="Coexisting with another chat widget" after={<Pill ring>Intercom · Zendesk · …</Pill>} />
        <div className="card-body col gap-4">
          <p className="text-md muted note">
            Already running Intercom, Zendesk, Freshchat, or your own help widget? You can hide crumb's edge tab entirely and open the feedback panel from your existing widget or any button. Set <span className="mono">Launcher visibility → Hidden</span> in <a href="/settings/branding" style={{ color: "var(--ink)" }}>Branding</a>, or hide it per-page with <span className="mono">data-launcher="hidden"</span>:
          </p>

          <Snippet title="Hidden launcher snippet" code={s.hidden} />

          <p className="text-sm muted note">
            Then trigger crumb from anywhere. The public <span className="mono">window.crumb</span> API is safe to call before the script finishes loading (calls queue and replay on mount):
          </p>

          <Snippet title="Your own button" code={s.api} />
          <Snippet title="From Intercom" code={s.intercom} />
          <Snippet title="From Zendesk" code={s.zendesk} />

          <p className="text-xs muted note">
            Prefer to keep both? Crumb's tab docks to the middle of the screen edge, so it doesn't collide with corner chat bubbles. If your product renders something mid-edge, set a <span className="mono">Vertical nudge</span> in Branding (or <span className="mono">data-offset="120"</span>) to slide the tab along the edge.
          </p>
        </div>
      </Card>

      {(inboundDomain || !cloud) && (
        <Card>
          <CardHead
            title="Email"
            after={inboundDomain ? <Pill ring ringFill>Configured</Pill> : <Pill ring>Not configured</Pill>}
          />
          <div className="card-body col gap-4">
            {captureAddress && (
              <div className="col gap-2">
                <Snippet title="Capture address" code={captureAddress} />
                <p className="text-sm muted note">
                  Forward a customer&apos;s email to this address and it lands in Needs triage in your Inbox.
                </p>
              </div>
            )}

            <p className="text-md muted note">
              {inboundDomain
                ? "Customers can reply to Crumb's notification emails, and the reply lands back on the thread."
                : "Once inbound email is set up, customers can reply to notification emails and the reply lands back on the thread. Until then, those emails go out from a noreply address."}
            </p>

            {!cloud && (
              <div className="col gap-3">
                <span className="eyebrow">Server setup (self-host)</span>
                {inboundDomain ? (
                  <>
                    <p className="text-sm note">
                      Point your mail provider&apos;s inbound webhook at <span className="mono">{s.origin}/api/v1/inbound/reply</span> for replies and <span className="mono">{s.origin}/api/v1/inbound/email</span> for forwarded mail. The Reply-To header on every notification is{" "}
                      <span className="mono">reply+&lt;shortId&gt;.&lt;token&gt;@{inboundDomain}</span>.
                      {!captureAddress && <> Set <span className="mono">CRUMB_INBOUND_SECRET</span> to get a capture address.</>}
                    </p>
                    <Snippet
                      title="Test the reply webhook"
                      code={`curl -X POST ${s.origin}/api/v1/inbound/reply \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $CRUMB_INBOUND_SECRET" \\
  -d '{
    "to": "reply+FB-1.<token>@${inboundDomain}",
    "from": "customer@acme.com",
    "text": "Looking forward to it. Any ETA?"
  }'`}
                    />
                  </>
                ) : (
                  <p className="text-sm note">
                    Set <span className="mono">CRUMB_INBOUND_DOMAIN</span> (e.g. <span className="mono">reply.yourdomain.com</span>) and <span className="mono">CRUMB_INBOUND_SECRET</span> in the dashboard&apos;s env, then have your mail provider POST inbound messages as JSON to <span className="mono">{s.origin}/api/v1/inbound/reply</span> (replies) and <span className="mono">{s.origin}/api/v1/inbound/email</span> (forwarded mail). The secret signs your capture address and protects both endpoints via <span className="mono">Authorization: Bearer …</span>.
                  </p>
                )}
              </div>
            )}
          </div>
        </Card>
      )}
    </>
  );
}
