import { redirect } from "next/navigation";
import { getSession, safeNextPath } from "@/lib/auth";
import { emailConfigured } from "@/lib/email";
import { isCloud } from "@/lib/tier";
import { LoginForm } from "./LoginForm";
import { BrandMark } from "@crumb/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

type SearchParams = {
  e?: string;
  next?: string;
};

const ERROR_COPY: Record<string, string> = {
  expired: "That link has expired. Request a fresh one below.",
  consumed: "That link was already used. Request a new one if you need it.",
  not_found: "We couldn't find that link. Request a new one below.",
};

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const next = safeNextPath(searchParams.next);
  const session = await getSession();
  if (session) redirect(next ?? "/inbox");

  const cloud = isCloud();
  const errorCode = searchParams.e;
  const error = errorCode ? (ERROR_COPY[errorCode] ?? null) : null;

  return (
    <main style={{
      background: "var(--cream)",
      minHeight: "100vh",
      display: "grid",
      placeItems: "center",
      padding: 16,
    }}>
      <div className="card" style={{ width: 380, maxWidth: "calc(100vw - 32px)", padding: 28 }}>
        <div className="col gap-4">
          <div className="row gap-3 center">
            <BrandMark width={36} height={36} />
            <div className="col">
              <span className="serif" style={{ fontSize: 22, lineHeight: 1.05 }}>Crumb</span>
              <span className="text-xs muted">Follow the trail.</span>
            </div>
          </div>

          <hr className="divider" />

          <div className="col gap-1">
            <h1 className="display" style={{ fontSize: 20, lineHeight: 1.2, margin: 0 }}>Sign in</h1>
            <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.5 }}>
              We'll email you a link. No password to remember.
            </p>
          </div>

          {error && (
            <div className="text-sm" style={{
              background: "var(--err-bg)",
              border: "1px solid var(--err-border)",
              color: "var(--err-text)",
              borderRadius: "var(--r-sm)",
              padding: "10px 12px",
            }}>{error}</div>
          )}

          <LoginForm next={next} stdoutHint={!cloud && !emailConfigured()} />

          {cloud ? (
            <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.55 }}>
              New to Crumb? <a href="/signup" style={{ color: "var(--ink)" }}>Start free</a>.
            </p>
          ) : (
            <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55 }}>
              No account yet? Ask an admin to invite you. Setting up a new server? Create the first admin with a <a href="/onboard" style={{ color: "var(--ink)" }}>setup link</a>.
            </p>
          )}

          <div className="text-xs muted" style={{ display: "flex", gap: 10, justifyContent: "center", borderTop: "var(--border)", paddingTop: 12 }}>
            <a href="https://crumb.localhostlabs.net/terms" target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>Terms</a>
            <a href="https://crumb.localhostlabs.net/privacy" target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>Privacy</a>
          </div>
        </div>
      </div>
    </main>
  );
}
