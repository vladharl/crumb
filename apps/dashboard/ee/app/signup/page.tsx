import { redirect } from "next/navigation";
import { BrandMark } from "@crumb/ui";
import { isCloud } from "@/lib/tier";
import { SignupForm } from "./SignupForm";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  expired: "That confirmation link is invalid or expired. Please sign up again.",
  failed: "Something went wrong creating your workspace. Please try again.",
};

export default function SignupPage({ searchParams }: { searchParams: { e?: string } }) {
  // Self-serve signup is a Cloud-only path. Self-host provisions its first
  // workspace via the operator setup link (/onboard).
  if (!isCloud()) redirect("/onboard");

  const error = searchParams.e ? ERRORS[searchParams.e] : null;
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
              <span className="text-xs muted">Create your workspace — free to start.</span>
            </div>
          </div>

          <hr className="divider" />

          {error && (
            <div className="text-sm" style={{
              background: "var(--err-bg)",
              border: "1px solid var(--err-border)",
              color: "var(--err-text)",
              borderRadius: "var(--r-sm)",
              padding: "10px 12px",
              lineHeight: 1.55,
            }}>{error}</div>
          )}

          <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.55 }}>
            We'll email you a link to confirm and finish setup. Already have a workspace?{" "}
            <a href="/login" style={{ color: "var(--ink)" }}>Sign in</a>.
          </p>

          <SignupForm turnstileSiteKey={turnstileSiteKey} />
        </div>
      </div>
    </main>
  );
}
