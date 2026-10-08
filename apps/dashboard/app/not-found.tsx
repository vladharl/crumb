import Link from "next/link";
import { BrandMark } from "@crumb/ui";

export const metadata = { title: "Not found" };

// Unmatched URLs anywhere, outside the app shell. Same card as sign-in. "Back to
// inbox" works signed in or out: /inbox sends a stranger on to sign-in.
export default function NotFound() {
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
            <h1 className="display" style={{ fontSize: 20, lineHeight: 1.2, margin: 0 }}>We couldn&apos;t find that</h1>
            <p className="text-sm muted note">The link may be out of date, or the page has moved.</p>
          </div>

          <div>
            <Link href="/inbox" className="btn primary" style={{ textDecoration: "none" }}>Back to inbox</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
