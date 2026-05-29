import { Card, CardHead, Pill } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { isCloud } from "@/lib/tier";
import { SecretReveal } from "./SecretReveal";
import { CopySnippetButton } from "./CopySnippetButton";

export const dynamic = "force-dynamic";

export default async function InstallPage() {
  const { workspace, user } = await getActiveSession();
  const inboundDomain = process.env.CRUMB_INBOUND_DOMAIN?.trim() || null;
  const cloud = isCloud();
  return (
    <>
      <Card>
        <CardHead title="Server-signed identity" after={<Pill ring ringFill>Recommended</Pill>} />
        <div className="card-body col gap-4">
          <p className="text-md muted" style={{ margin: 0, maxWidth: "62ch", lineHeight: 1.55 }}>
            Sign a short-lived JWT on your server with the workspace's secret and hand it to the widget. The widget passes it as <span className="mono">Authorization: Bearer</span> on every API call; Crumb trusts the signed claims, never the page DOM.
          </p>

          <div className="code">
{`<!-- in your page template, server-rendered -->
<script src="https://your-crumb-host/widget.js"
        data-workspace="`}<span className="k">{workspace.slug}</span>{`"
        data-user-jwt="`}<span className="k">{`{signedIdentityJwt}`}</span>{`"
        defer></script>`}
          </div>

          <div className="code">
{`// Node example — sign per request, cache for ~50 min
import { createHmac } from "node:crypto";

function b64u(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\\+/g, "-").replace(/\\//g, "_");
}
function signCrumbIdentity(user) {
  const header  = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims  = b64u(JSON.stringify({
    iss: "`}<span className="k">{workspace.slug}</span>{`",
    sub: user.email,
    name: user.name,
    account_name: user.account.name,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  }));
  const sig = b64u(createHmac("sha256", process.env.CRUMB_SIGNING_SECRET).update(\`\${header}.\${claims}\`).digest());
  return \`\${header}.\${claims}.\${sig}\`;
}`}
          </div>

          <SecretReveal isAdmin={user.role === "admin"} />
        </div>
      </Card>

      <Card>
        <CardHead title="Snippet (development)" after={<Pill ring>Trusts the browser</Pill>} />
        <div className="card-body col gap-4">
          <p className="text-md muted" style={{ margin: 0, maxWidth: "62ch", lineHeight: 1.55 }}>
            For demos and the bundled <span className="mono">/widget-demo.html</span>, the widget accepts identity from <span className="mono">data-*</span> attributes. Anyone with view-source can impersonate; switch to JWT before going to production.
          </p>

          <div className="code">
{`<script src="https://your-crumb-host/widget.js"
        data-workspace="`}<span className="k">{workspace.slug}</span>{`"
        data-user-email="`}<span className="k">{`{currentUser.email}`}</span>{`"
        data-user-name="`}<span className="k">{`{currentUser.name}`}</span>{`"
        data-account-name="`}<span className="k">{`{currentUser.account.name}`}</span>{`"
        defer></script>`}
          </div>

          <div className="row gap-2" style={{ flexWrap: "wrap" }}>
            <CopySnippetButton snippet={`<script src="https://your-crumb-host/widget.js"
        data-workspace="${workspace.slug}"
        data-user-email="{currentUser.email}"
        data-user-name="{currentUser.name}"
        data-account-name="{currentUser.account.name}"
        defer></script>`} />
            <div style={{ flex: 1 }} />
            {!cloud && (
              <a
                href={`/widget-demo.html?ws=${encodeURIComponent(workspace.slug)}&email=customer@example.com&account=${encodeURIComponent("Test Co")}&name=Customer`}
                target="_blank"
                rel="noreferrer"
                className="text-sm"
                style={{ color: "var(--ink)" }}
              >
                Open the demo embed →
              </a>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <CardHead
          title="Inbound email replies"
          after={inboundDomain ? <Pill ring ringFill>Configured</Pill> : <Pill ring>Not configured</Pill>}
        />
        <div className="card-body col gap-4">
          <p className="text-md muted" style={{ margin: 0, maxWidth: "62ch", lineHeight: 1.55 }}>
            When wired, customers can reply to vendor notification emails and the reply lands back on the thread. Until then, those emails go out from a noreply address.
          </p>

          {inboundDomain ? (
            <>
              <div className="col gap-2">
                <span className="eyebrow">Inbound domain</span>
                <div className="code">{inboundDomain}</div>
                <span className="text-xs muted">
                  Point your provider's inbound webhook at <span className="mono">/api/v1/inbound/reply</span> on this host. The Reply-To header on every notification is{" "}
                  <span className="mono">reply+&lt;shortId&gt;.&lt;token&gt;@{inboundDomain}</span>.
                </span>
              </div>

              <div className="code">
{`# Test the webhook locally
curl -X POST http://localhost:3000/api/v1/inbound/reply \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "reply+FB-1.<token>@${inboundDomain}",
    "from": "customer@acme.com",
    "text": "Looking forward to it. Any ETA?"
  }'`}
              </div>
            </>
          ) : (
            <>
              <p className="text-sm" style={{ margin: 0, maxWidth: "62ch", lineHeight: 1.55 }}>
                Set <span className="mono">CRUMB_INBOUND_DOMAIN</span> in the dashboard's env (e.g. <span className="mono">reply.yourdomain.com</span>) and configure your mail provider to POST inbound messages as JSON to <span className="mono">/api/v1/inbound/reply</span>. Optionally protect the endpoint with <span className="mono">CRUMB_INBOUND_SECRET</span> + <span className="mono">Authorization: Bearer …</span>.
              </p>
            </>
          )}
        </div>
      </Card>
    </>
  );
}
