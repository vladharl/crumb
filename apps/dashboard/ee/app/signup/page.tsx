import { redirect } from "next/navigation";
import { BrandMark } from "@crumb/ui";
import { isCloud } from "@/lib/tier";
import { ConfirmSignup, SignupForm } from "./SignupForm";
import { billingParams, findOpenPendingSignup } from "./pending";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign up" };

const ERROR_BOX = {
  background: "var(--err-bg)",
  border: "1px solid var(--err-border)",
  color: "var(--err-text)",
  borderRadius: "var(--r-sm)",
  padding: "10px 12px",
  lineHeight: 1.55,
};

type SearchParams = { e?: string; token?: string; plan?: string; interval?: string };

export default async function SignupPage({ searchParams }: { searchParams: SearchParams }) {
  // Self-serve signup is a Cloud-only path. Self-host provisions its first
  // workspace via the operator setup link (/onboard).
  if (!isCloud()) redirect("/onboard");

  // A pricing CTA's ?plan=&interval= ride along to billing (see billingParams).
  const billing = billingParams(searchParams.plan, searchParams.interval);
  // The emailed link lands here with its token. Looking it up changes nothing
  // (mail scanners open links too); only the Create button's POST spends it.
  const token = typeof searchParams.token === "string" ? searchParams.token : "";
  const signup = token ? await findOpenPendingSignup({ token }) : null;
  const live = signup && signup.expiresAt > new Date() ? signup : null;

  const error = searchParams.e === "failed"
    ? "Something went wrong creating your workspace. Please try again."
    : token && !signup
      ? "That link has already been used, or it isn't valid. If your workspace is ready, sign in. If not, start again below."
      : null;
  // Read at runtime on the server (not a NEXT_PUBLIC build-time inline), so the
  // site key can be set via env without rebuilding the image.
  const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY?.trim() || null;

  return (
    <main style={{
      background: "var(--cream)",
      minHeight: "100vh",
      display: "grid",
      placeItems: "center",
      padding: 16,
    }}>
      <div className="card" style={{ width: 440, maxWidth: "calc(100vw - 32px)", padding: 28 }}>
        <div className="col gap-4">
          <div className="row gap-3 center">
            <BrandMark width={36} height={36} />
            <div className="col">
              <span className="serif" style={{ fontSize: 22, lineHeight: 1.05 }}>Start with Crumb</span>
              <span className="text-xs muted">Create your workspace. It's free to start.</span>
            </div>
          </div>

          <hr className="divider" />

          {error && <div className="text-sm" role="alert" style={ERROR_BOX}>{error}</div>}

          {live ? (
            <ConfirmSignup token={token} billing={billing}>
              <p className="text-sm note">
                Create <strong style={{ fontWeight: 600 }}>{live.workspaceName}</strong> with{" "}
                <span className="mono">{live.adminEmail}</span> as its admin. You'll be signed in right after.
              </p>
            </ConfirmSignup>
          ) : (
            <>
              <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.55 }}>
                We'll email you a link to confirm and finish setup. Already have a workspace?{" "}
                <a href="/login" style={{ color: "var(--ink)" }}>Sign in</a>.
              </p>

              <SignupForm
                turnstileSiteKey={turnstileSiteKey}
                billing={billing}
                expired={signup ? {
                  workspaceName: signup.workspaceName,
                  adminName: signup.adminName,
                  adminEmail: signup.adminEmail,
                } : undefined}
              />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
